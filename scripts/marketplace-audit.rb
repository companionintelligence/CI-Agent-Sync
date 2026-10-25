#!/usr/bin/env ruby

# Read-only audit for the release-facing Marketplace projections of the
# Companion Intelligence agent harnesses. It deliberately checks public
# manifest metadata and compose wiring only; credentials stay in Hub handouts,
# 1Password, or the native client store.

require "json"
require "open3"
require "optparse"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
CONTRACT_PATH = File.join(STORE_ROOT, "integrations", "marketplace-harnesses.yaml")

options = { json: false, strict: false, marketplace: nil, sources_root: nil }
OptionParser.new do |parser|
  parser.banner = "Usage: marketplace-audit.rb [--marketplace PATH] [--sources-root PATH] [--json] [--strict]"
  parser.on("--marketplace PATH", "CI-Marketplace checkout to inspect") { |value| options[:marketplace] = value }
  parser.on("--sources-root PATH", "Parent directory containing source harness checkouts") { |value| options[:sources_root] = value }
  parser.on("--json") { options[:json] = true }
  parser.on("--strict", "Treat skipped optional source checks as errors") { options[:strict] = true }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def expand(value, ci_root)
  value.to_s
       .gsub("${CI_ROOT}", ci_root)
       .gsub("${HOME}", Dir.home)
       .gsub("$HOME", Dir.home)
end

def local_profile
  path = File.join(STORE_ROOT, "profiles", "machines", "local.yaml")
  File.file?(path) ? YAML.safe_load_file(path, aliases: false) : {}
rescue StandardError
  {}
end

def default_marketplace_root
  profile = local_profile
  ci_root = ENV.fetch("CI_ROOT", File.join(Dir.home, "devel", "ci"))
  profile.dig("paths", "ci_marketplace") || File.join(ci_root, "CI-Marketplace")
end

def add_check(checks, id, status, detail)
  checks << { "id" => id, "status" => status, "detail" => detail }
end

def json_file(path)
  JSON.parse(File.read(path))
rescue StandardError => error
  raise "#{path}: #{error.message}"
end

def service_by_name(services, name)
  services.find { |service| service.is_a?(Hash) && service["name"] == name }
end

def environment_keys(service)
  Array(service && service["environment"]).filter_map do |entry|
    entry.is_a?(Hash) ? entry["key"] : nil
  end
end

def pinned_image?(image)
  image.to_s.match?(/@sha256:[0-9a-f]{64}\z/i)
end

def image_has_version?(image, version)
  image.to_s.include?(":#{version}@sha256:")
end

def latest_release_tag(source_path, prefix)
  output, _error, status = Open3.capture3(
    "git", "-C", source_path, "tag", "--merged", "origin/master", "--sort=-version:refname"
  )
  unless status.success?
    output, _error, status = Open3.capture3(
      "git", "-C", source_path, "tag", "--merged", "HEAD", "--sort=-version:refname"
    )
  end
  return nil unless status.success?

  pattern = prefix.to_s.empty? ? /\A\d{4}\.\d+\.\d+\z/ : /\Av\d{4}\.\d+\.\d+\z/
  output.lines.map(&:strip).find { |tag| tag.match?(pattern) }
end

contract = YAML.safe_load_file(CONTRACT_PATH, aliases: false)
marketplace_root = File.expand_path(options[:marketplace] || ENV["CI_MARKETPLACE_ROOT"] || default_marketplace_root)
sources_root = options[:sources_root] && File.expand_path(options[:sources_root])
checks = []

unless File.directory?(marketplace_root)
  add_check(checks, "marketplace.checkout", "error", "missing checkout: #{marketplace_root}")
else
  add_check(checks, "marketplace.checkout", "ok", "present: #{marketplace_root}")
end

contract.fetch("harnesses").each do |harness, expected|
  slug = expected.fetch("marketplace_slug")
  config_path = File.join(marketplace_root, contract.dig("source", "manifest_root").to_s, slug, "config.json")
  compose_path = File.join(marketplace_root, contract.dig("source", "manifest_root").to_s, slug, "docker-compose.json")
  prefix = expected.fetch("release_tag_prefix", "")
  base_id = "marketplace.#{harness}"

  unless File.file?(config_path)
    add_check(checks, "#{base_id}.config", "error", "missing #{config_path}")
    next
  end
  unless File.file?(compose_path)
    add_check(checks, "#{base_id}.compose", "error", "missing #{compose_path}")
    next
  end

  begin
    config = json_file(config_path)
    compose = json_file(compose_path)
    hub = config.fetch("hub_integration")
    expected_hub = expected.fetch("hub_integration")
    services = compose.fetch("services")
    main = service_by_name(services, expected.dig("compose", "main_service"))

    if config["id"] == slug
      add_check(checks, "#{base_id}.id", "ok", "id matches #{slug}")
    else
      add_check(checks, "#{base_id}.id", "error", "id #{config["id"].inspect} does not match #{slug}")
    end

    version = config.fetch("version").to_s
    add_check(checks, "#{base_id}.version", version.empty? ? "error" : "ok", version.empty? ? "version is empty" : "catalog version #{version}")

    if hub["mcp_client"] == expected_hub["mcp_client"]
      add_check(checks, "#{base_id}.hub.mcp", "ok", "Hub MCP client enabled")
    else
      add_check(checks, "#{base_id}.hub.mcp", "error", "expected hub_integration.mcp_client=true")
    end

    expected_hub.fetch("memory").each do |key, value|
      actual = hub.dig("memory", key)
      if actual == value
        add_check(checks, "#{base_id}.hub.memory.#{key}", "ok", "maps to #{value}")
      else
        add_check(checks, "#{base_id}.hub.memory.#{key}", "error", "expected #{value}, got #{actual.inspect}")
      end
    end

    expected_hub.fetch("inference").each do |key, value|
      actual = hub.dig("inference", key)
      if actual == value
        add_check(checks, "#{base_id}.hub.inference.#{key}", "ok", "maps to #{value}")
      else
        add_check(checks, "#{base_id}.hub.inference.#{key}", "error", "expected #{value}, got #{actual.inspect}")
      end
    end

    %w[wake_endpoint wake_port].each do |key|
      next unless expected_hub.key?(key)
      if hub[key] == expected_hub[key]
        add_check(checks, "#{base_id}.hub.#{key}", "ok", "matches #{expected_hub[key]}")
      else
        add_check(checks, "#{base_id}.hub.#{key}", "error", "expected #{expected_hub[key]}, got #{hub[key].inspect}")
      end
    end

    if main
      add_check(checks, "#{base_id}.compose.main", "ok", "main service #{main["name"]} present")
      actual_env = environment_keys(main)
      expected.dig("compose", "required_env").each do |env_name|
        if actual_env.include?(env_name)
          add_check(checks, "#{base_id}.compose.env.#{env_name}", "ok", "declared")
        else
          add_check(checks, "#{base_id}.compose.env.#{env_name}", "error", "missing from #{main["name"]}")
        end
      end
    else
      add_check(checks, "#{base_id}.compose.main", "error", "missing service #{expected.dig("compose", "main_service")}")
    end

    images = services.filter_map { |service| service["image"] if service.is_a?(Hash) }
    if images.empty?
      add_check(checks, "#{base_id}.compose.images", "error", "no service images declared")
    else
      unpinned = images.reject { |image| pinned_image?(image) }
      wrong_version = images.reject { |image| image_has_version?(image, version) }
      if contract.dig("policy", "require_sha256_image_pins") && !unpinned.empty?
        add_check(checks, "#{base_id}.compose.pins", "error", "unpinned image reference present")
      else
        add_check(checks, "#{base_id}.compose.pins", "ok", "all #{images.length} image reference(s) are sha256-pinned")
      end
      if wrong_version.empty?
        add_check(checks, "#{base_id}.compose.release", "ok", "all app images carry :#{version}")
      else
        add_check(checks, "#{base_id}.compose.release", "error", "an app image does not carry catalog version #{version}")
      end
    end

    if sources_root
      source_path = File.join(sources_root, expected.fetch("source_checkout_name"))
      if File.directory?(File.join(source_path, ".git"))
        source_tag = latest_release_tag(source_path, prefix)
        if source_tag == version
          add_check(checks, "#{base_id}.source.release", "ok", "source tag #{source_tag} matches catalog")
        else
          add_check(checks, "#{base_id}.source.release", "error", "source tag #{source_tag || "not found"} does not match catalog #{version}")
        end
      else
        status = options[:strict] ? "error" : "warn"
        add_check(checks, "#{base_id}.source.release", status, "source checkout missing: #{source_path}")
      end
    else
      status = options[:strict] ? "error" : "warn"
      add_check(checks, "#{base_id}.source.release", status, "skipped; pass --sources-root for local release comparison")
    end
  rescue StandardError => error
    add_check(checks, "#{base_id}.parse", "error", error.message)
  end
end

summary = checks.group_by { |item| item["status"] }.transform_values(&:length)
result = {
  "schema_version" => 1,
  "contract" => File.basename(CONTRACT_PATH),
  "marketplace" => marketplace_root,
  "sources_root" => sources_root,
  "summary" => summary,
  "checks" => checks,
}

if options[:json]
  puts JSON.pretty_generate(result)
else
  checks.each do |item|
    icon = { "ok" => "✓", "warn" => "!", "error" => "✗" }.fetch(item["status"], "·")
    puts "#{icon} #{item["id"]}: #{item["detail"]}"
  end
  puts "Marketplace harness audit: #{summary.fetch("error", 0)} error(s), #{summary.fetch("warn", 0)} warning(s)"
end

exit 1 if summary.fetch("error", 0).positive?
