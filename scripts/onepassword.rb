#!/usr/bin/env ruby

# Small, non-secret 1Password adapter used by bin/agent-store. Secret values
# enter only through stdin or op read and are never written to stdout/stderr.

require "json"
require "open3"
require "optparse"
require "timeout"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
PROVIDERS = %w[
  anthropic openai openrouter ollama omlx companion-hub companion-hub-qa
  companion-hub-inference companion-memory omniroute android-mcp cloudflare
].freeze

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

def item_names(options)
  output, _error, status = run_op(options, "item", "list", "--vault", options[:vault], "--format=json")
  return nil unless status.success?

  parsed = JSON.parse(output)
  Array(parsed).each_with_object({}) do |item, names|
    name = item["title"] || item["id"]
    names[name] = true if name && !name.empty?
  end
rescue JSON::ParserError
  nil
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
    stdin, stdout, stderr, wait = Open3.popen3(*op_command(options, "item", "edit", item_name(provider), "--vault", options[:vault], "-"), pgroup: true)
  else
    input = JSON.generate(
      "category" => "API_CREDENTIAL",
      "title" => item_name(provider),
      "tags" => ["agent-configs", "provider:#{provider}"],
      "fields" => [{ "id" => "credential", "type" => "CONCEALED", "label" => "credential", "value" => secret }],
    )
    stdin, stdout, stderr, wait = Open3.popen3(*op_command(options, "item", "create", "--vault", options[:vault], "-"), pgroup: true)
  end
  error = ""
  status = nil
  timed_out = false
  output_thread = Thread.new { stdout.read rescue "" }
  error_thread = Thread.new { stderr.read rescue "" }
  begin
    Timeout.timeout(30) do
      stdin.write(input)
      stdin.close
      status = wait.value
    end
  rescue Timeout::Error
    timed_out = true
    Process.kill("TERM", -wait.pid) rescue Process.kill("TERM", wait.pid) rescue nil
    sleep 0.05
    Process.kill("KILL", -wait.pid) rescue Process.kill("KILL", wait.pid) rescue nil
    stdin.close rescue nil
    stdout.close rescue nil
    stderr.close rescue nil
    output_thread.kill
    error_thread.kill
    output_thread.join(0.2)
    error_thread.join(0.2)
    wait.join(0.5)
  ensure
    stdin.close rescue nil
    stdout.close rescue nil
    stderr.close rescue nil
  end
  unless timed_out
    output_thread.value rescue nil
    error = error_thread.value rescue ""
  end
  output_thread.kill if timed_out
  error_thread.kill if timed_out
  abort "1Password item write timed out for #{provider}; approve the desktop CLI request and retry" if timed_out
  abort "1Password item write failed for #{provider}: #{error.lines.first.to_s.strip}" unless status&.success?
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
  names = item_names(options)
  if names.nil?
    puts "1Password items: unavailable — approve the desktop CLI request and retry"
  else
    PROVIDERS.each do |provider|
      item = item_name(provider)
      unless names[item]
        puts "  · #{provider} — item missing"
        next
      end
      _value, _error, status = run_op(options, "read", "--no-newline", reference(options, provider))
      puts "  #{status.success? ? "✓" : "·"} #{provider} — #{status.success? ? "credential available" : "credential field missing"}"
    end
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
