#!/usr/bin/env ruby

require "json"
require "pathname"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
options = { json: ARGV.delete("--json") }
checks = []

def add_check(checks, id, status, detail)
  checks << { "id" => id, "status" => status, "detail" => detail }
end

yaml_files = Dir[
  File.join(STORE_ROOT, "integrations", "**", "*.yaml"),
  File.join(STORE_ROOT, "profiles", "**", "*.yaml"),
  File.join(STORE_ROOT, "repos", "**", "*.yaml"),
  File.join(STORE_ROOT, "sync", "**", "*.yaml"),
  File.join(STORE_ROOT, "providers", "**", "*.yaml"),
].uniq
yaml_files.each do |path|
  begin
    YAML.safe_load_file(path, aliases: true)
    add_check(checks, "yaml.#{Pathname.new(path).relative_path_from(Pathname.new(STORE_ROOT))}", "ok", "parses")
  rescue StandardError => error
    add_check(checks, "yaml.#{Pathname.new(path).relative_path_from(Pathname.new(STORE_ROOT))}", "error", "#{error.class}: #{error.message}")
  end
end

Dir[File.join(STORE_ROOT, "integrations", "**", "*.json"), File.join(STORE_ROOT, "agents", "**", "*.json")].uniq.each do |path|
  begin
    JSON.parse(File.read(path))
    add_check(checks, "json.#{Pathname.new(path).relative_path_from(Pathname.new(STORE_ROOT))}", "ok", "parses")
  rescue StandardError => error
    add_check(checks, "json.#{Pathname.new(path).relative_path_from(Pathname.new(STORE_ROOT))}", "error", "#{error.class}: #{error.message}")
  end
end

begin
  providers = YAML.safe_load_file(File.join(STORE_ROOT, "providers", "providers.yaml"), aliases: false).fetch("providers")
  routing = YAML.safe_load_file(File.join(STORE_ROOT, "integrations", "providers", "routing.yaml"), aliases: false)
  fallback = YAML.safe_load_file(File.join(STORE_ROOT, "integrations", "providers", "fallbacks.yaml"), aliases: false)
  bundles = YAML.safe_load_file(File.join(STORE_ROOT, "integrations", "capability-bundles.yaml"), aliases: false)
  harnesses = YAML.safe_load_file(File.join(STORE_ROOT, "integrations", "harnesses.yaml"), aliases: false).fetch("harnesses")
  registry = YAML.safe_load_file(File.join(STORE_ROOT, "integrations", "mcp", "registry.yaml"), aliases: false).fetch("servers")

  fallback.fetch("providers").each_key do |name|
    add_check(checks, "reference.provider.#{name}", providers.key?(name) ? "ok" : "error", providers.key?(name) ? "declared" : "missing from providers/providers.yaml")
  end
  fallback.fetch("chains").each do |name, chain|
    chain.fetch("steps").each do |step|
      provider = step.fetch("provider")
      add_check(checks, "reference.chain.#{name}.#{provider}", providers.key?(provider) ? "ok" : "error", "provider is declared")
    end
  end
  known_clients = harnesses.keys
  registry.each do |name, server|
    Array(server["clients"]).concat(Array(server["optional_clients"])).uniq.each do |client|
      valid = known_clients.include?(client)
      add_check(checks, "reference.mcp.#{name}.#{client}", valid ? "ok" : "error", valid ? "client is declared" : "client missing from integrations/harnesses.yaml")
    end
  end
  bundles.fetch("bundles").each do |name, bundle|
    Array(bundle["servers"]).each do |server|
      valid = registry.key?(server)
      add_check(checks, "reference.bundle.#{name}.#{server}", valid ? "ok" : "error", valid ? "server is declared" : "server missing from MCP registry")
    end
  end
  valid_routes = routing.fetch("routes").values.all? { |route| route["primary"].nil? || providers.key?(route["primary"]) }
  add_check(checks, "routing.providers", valid_routes ? "ok" : "error", "routing providers are declared")
rescue StandardError => error
  add_check(checks, "cross-references", "error", "#{error.class}: #{error.message}")
end

begin
  manifest = YAML.safe_load_file(File.join(STORE_ROOT, "sync", "manifest.yaml"), aliases: false)
  missing = manifest.fetch("items").filter_map do |item|
    source = File.join(STORE_ROOT, item.fetch("source"))
    item.fetch("source") unless File.file?(source)
  end
  add_check(checks, "sync.manifest", missing.empty? ? "ok" : "error", missing.empty? ? "all sources exist" : "missing: #{missing.join(", ")}")
rescue StandardError => error
  add_check(checks, "sync.manifest", "error", "#{error.class}: #{error.message}")
end

summary = checks.group_by { |item| item["status"] }.transform_values(&:length)
result = { "schema_version" => 1, "summary" => summary, "checks" => checks }
if options[:json]
  puts JSON.pretty_generate(result)
else
  checks.each do |item|
    icon = { "ok" => "✓", "warn" => "!", "error" => "✗" }.fetch(item["status"], "·")
    puts "#{icon} #{item["id"]}: #{item["detail"]}"
  end
  puts "Validation: #{summary.fetch("error", 0)} error(s), #{summary.fetch("warn", 0)} warning(s)"
end
exit 1 if summary.fetch("error", 0).positive?
