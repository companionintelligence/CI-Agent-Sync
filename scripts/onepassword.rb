#!/usr/bin/env ruby

# Small, non-secret 1Password adapter used by bin/agent-store. Secret values
# enter only through stdin or op read and are never written to stdout/stderr.

require "json"
require "open3"
require "optparse"
require "timeout"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
PROVIDERS = %w[anthropic openai openrouter ollama omlx companion-hub companion-memory omniroute android-mcp].freeze

options = {
  vault: ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs"),
  account: ENV["OP_ACCOUNT"],
}
OptionParser.new do |parser|
  parser.on("--vault NAME") { |value| options[:vault] = value }
  parser.on("--account NAME") { |value| options[:account] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!(ARGV)
command = ARGV.shift
FAILED_STATUS = Struct.new(:ok) { def success? = ok }.new(false)

def op_command(options, *args)
  command = [ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")]
  command.concat(["--account", options[:account]]) if options[:account] && !options[:account].empty?
  command.concat(args)
  command
end

def capture_with_timeout(command, timeout_seconds)
  AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
end

def run_op(options, *args)
  output, error, status = capture_with_timeout(op_command(options, *args), 30)
  [output, error, status || FAILED_STATUS]
end

def op_installed?
  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  File.executable?(binary) || system("which", binary, out: File::NULL, err: File::NULL)
end

def signed_in?(options)
  _out, _err, status = run_op(options, "vault", "list", "--format=json")
  status.success?
end

def vault_exists?(options)
  _out, _err, status = run_op(options, "vault", "get", options[:vault], "--format=json")
  status.success?
end

def item_name(provider)
  "agent-configs-#{provider}"
end

def reference(options, provider)
  "op://#{options[:vault]}/#{item_name(provider)}/credential"
end

def item_json(options, provider)
  output, _error, status = run_op(options, "item", "get", item_name(provider), "--vault", options[:vault], "--format=json")
  return [nil, status] unless status.success?

  [JSON.parse(output), status]
rescue JSON::ParserError
  [nil, false]
end

def ensure_owned_item!(item, provider)
  return unless item
  tags = Array(item["tags"])
  return if tags.include?("agent-configs")

  abort "Refusing to overwrite existing untagged 1Password item #{item_name(provider)}; rename it or add the agent-configs tag first."
end

def write_item(options, provider, secret)
  abort "empty credential" if secret.nil? || secret.empty?
  item, _status = item_json(options, provider)
  ensure_owned_item!(item, provider)

  if item
    fields = Array(item["fields"])
    field = fields.find { |entry| entry["id"] == "credential" || entry["label"] == "credential" }
    if field
      field["id"] = "credential"
      field["type"] = "CONCEALED"
      field["label"] = "credential"
      field["value"] = secret
    else
      fields << { "id" => "credential", "type" => "CONCEALED", "label" => "credential", "value" => secret }
    end
    item["fields"] = fields
    input = JSON.generate(item)
    stdin, stdout, stderr, wait = Open3.popen3(*op_command(options, "item", "edit", item_name(provider), "--vault", options[:vault], "-"))
  else
    input = JSON.generate(
      "category" => "API_CREDENTIAL",
      "title" => item_name(provider),
      "tags" => ["agent-configs", "provider:#{provider}"],
      "fields" => [{ "id" => "credential", "type" => "CONCEALED", "label" => "credential", "value" => secret }],
    )
    stdin, stdout, stderr, wait = Open3.popen3(*op_command(options, "item", "create", "--vault", options[:vault], "-"))
  end
  stdin.write(input)
  stdin.close
  _result = stdout.read
  error = stderr.read
  status = wait.value
  abort "1Password item write failed for #{provider}: #{error.lines.first.to_s.strip}" unless status.success?
  true
end

case command
when "status"
  unless op_installed?
    puts "1Password CLI: not installed"
    exit 0
  end
  puts "1Password CLI: installed"
  unless signed_in?(options)
    puts "1Password session: not authenticated"
    puts "Enable the desktop CLI integration, then run: op signin"
    exit 0
  end
  puts "1Password session: authenticated"
  unless vault_exists?(options)
    puts "1Password vault: missing — run agentctl credentials op setup"
    exit 0
  end
  puts "1Password vault: #{options[:vault]}"
  PROVIDERS.each do |provider|
    _value, _error, status = run_op(options, "read", "--no-newline", reference(options, provider))
    puts "  #{status.success? ? "✓" : "·"} #{provider} — #{status.success? ? "credential available" : "item or field missing"}"
  end
when "refs"
  PROVIDERS.each { |provider| puts "#{provider}\top://#{options[:vault]}/#{item_name(provider)}/credential" }
when "setup"
  abort "1Password CLI is not installed" unless op_installed?
  abort "1Password is not authenticated; enable desktop CLI integration and run op signin first" unless signed_in?(options)
  unless vault_exists?(options)
    _out, error, status = run_op(options, "vault", "create", options[:vault], "--description", "Portable agent credentials for agent-configs")
    abort "could not create 1Password vault: #{error.lines.first.to_s.strip}" unless status.success?
    puts "Created 1Password vault: #{options[:vault]}"
  else
    puts "1Password vault already exists: #{options[:vault]}"
  end
  puts "Next: ./bin/agentctl credentials op import"
when "put"
  provider = ARGV.shift
  abort "usage: onepassword.rb put PROVIDER" unless PROVIDERS.include?(provider)
  abort "1Password is not authenticated" unless signed_in?(options) && vault_exists?(options)
  write_item(options, provider, STDIN.read)
  puts "Stored #{provider} in 1Password item #{item_name(provider)}."
else
  warn "Usage: onepassword.rb status|refs|setup|put PROVIDER"
  exit 2
end
