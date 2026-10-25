#!/usr/bin/env ruby

require "json"
require "net/http"
require "open3"
require "optparse"
require "timeout"
require "uri"
require "yaml"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
options = { json: false, timeout: 15 }
OptionParser.new do |parser|
  parser.banner = "Usage: conformance.rb [--json] [--timeout SECONDS]"
  parser.on("--json") { options[:json] = true }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def expand_path(value)
  value.to_s
    .gsub("${HOME}", Dir.home)
    .gsub("${USERPROFILE}", ENV.fetch("USERPROFILE", Dir.home))
    .gsub("${APPDATA}", ENV.fetch("APPDATA", File.join(Dir.home, "Library", "Application Support")))
end

def command_result(command, timeout_seconds)
  output, _error, status = capture_with_timeout(command, timeout_seconds)
  return { "status" => "warn", "detail" => "timed out" } if status.nil?
  detail = output.lines.map(&:strip).find { |line| !line.empty? }.to_s
  if output.lstrip.start_with?("{")
    parsed = JSON.parse(output) rescue nil
    detail = parsed["ok"] == true ? "healthy" : detail if parsed.is_a?(Hash)
  end
  { "status" => status.success? ? "ok" : "warn", "detail" => detail[0, 220] }
rescue Errno::ENOENT
  { "status" => "not-installed", "detail" => "command not found" }
rescue StandardError => error
  { "status" => "warn", "detail" => error.class.to_s }
end

def capture_with_timeout(command, timeout_seconds)
  AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
end

$agent_config_op_items = nil

def onepassword_item_names
  return $agent_config_op_items unless $agent_config_op_items.nil?

  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
  output, _error, status = capture_with_timeout([binary, "item", "list", "--vault", vault, "--format=json"], 12)
  parsed = JSON.parse(output) rescue []
  $agent_config_op_items = status&.success? ? Array(parsed).filter_map { |item| item["title"] || item["id"] } : []
rescue StandardError
  $agent_config_op_items = []
end

def http_result(base, path, token = nil)
  uri = URI.join(base.end_with?("/") ? base : "#{base}/", path.delete_prefix("/"))
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = 2
  http.read_timeout = 4
  request = Net::HTTP::Get.new(uri.request_uri)
  request["Authorization"] = "Bearer #{token}" if token && !token.empty?
  response = http.request(request)
  detail = "HTTP #{response.code}"
  detail += "; authentication required" if response.code.to_i == 401
  { "status" => response.code.to_i == 200 ? "ok" : "warn", "detail" => detail }
rescue StandardError => error
  { "status" => "warn", "detail" => "unreachable: #{error.class}" }
end

def stored_http_result(base, path, provider, timeout_seconds)
  env_name = {
    "omlx" => "OMLX_API_KEY",
    "omniroute" => "OMNIROUTE_API_KEY",
  }.fetch(provider)
  uri = URI.join(base.end_with?("/") ? base : "#{base}/", path.delete_prefix("/"))
  probe = <<~'RUBY'
    require "net/http"
    require "uri"

    uri = URI(ARGV.fetch(0))
    request = Net::HTTP::Get.new(uri.request_uri)
    key = ENV[ARGV.fetch(1)]
    request["Authorization"] = "Bearer #{key}" if key && !key.empty?
    response = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: 2, read_timeout: 4) do |http|
      http.request(request)
    end
    print response.code
  RUBY
  output, _error, status = AgentConfigProcess.capture_with_timeout(
    [File.join(ROOT, "bin", "agent-store"), "with", provider, "--", RbConfig.ruby, "-e", probe, uri.to_s, env_name],
    timeout_seconds,
  )
  return { "status" => "warn", "detail" => "credential unavailable" } if status.nil? || !status.success?

  code = output.strip
  detail = "HTTP #{code}"
  detail += "; authentication required" if code == "401"
  { "status" => code == "200" ? "ok" : "warn", "detail" => detail }
rescue StandardError => error
  { "status" => "warn", "detail" => "unreachable: #{error.class}" }
end

def secret_available?(provider)
  return false if ENV["AGENT_CONFIGS_SECRET_BACKEND"] == "native"
  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  return false unless system("which", binary, out: File::NULL, err: File::NULL)
  vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
  return false unless onepassword_item_names.include?("agent-configs-#{provider}")
  _value, _error, read_status = capture_with_timeout([binary, "read", "--no-newline", "op://#{vault}/agent-configs-#{provider}/credential"], 12)
  return false if read_status.nil?
  read_status.success?
rescue Timeout::Error, StandardError
  false
end

def secret_value(provider)
  return nil if ENV["AGENT_CONFIGS_SECRET_BACKEND"] == "native"
  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  if system("which", binary, out: File::NULL, err: File::NULL)
    vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
    if onepassword_item_names.include?("agent-configs-#{provider}")
      output, _error, status = capture_with_timeout([binary, "read", "--no-newline", "op://#{vault}/agent-configs-#{provider}/credential"], 12)
      return output.strip if status&.success? && !output.strip.empty?
    end
  end
  if RUBY_PLATFORM.include?("darwin") && system("which", "security", out: File::NULL, err: File::NULL)
    output, _error, status = Open3.capture3("security", "find-generic-password", "-a", ENV.fetch("USER", ""), "-s", "agent-configs/#{provider}", "-w")
    return output.strip if status.success? && !output.strip.empty?
  end
  nil
rescue Timeout::Error, StandardError
  nil
end

def config_path_for(metadata)
  platform = if RUBY_PLATFORM.include?("darwin")
               "macos"
             elsif RUBY_PLATFORM.include?("linux")
               "linux"
             else
               "windows"
             end
  expand_path(metadata.dig("config_paths", platform).to_s)
end

harnesses = YAML.safe_load_file(File.join(ROOT, "integrations", "harnesses.yaml"), aliases: false).fetch("harnesses")
results = {}

harnesses.each do |name, metadata|
  result = { "installed" => false, "configured" => false, "checks" => [] }
  if metadata["command"]
    command = metadata["command"] == "openclaw" ? File.join(ROOT, "bin", "openclaw-runtime") : metadata["command"]
    probe = command_result([command, "--version"], options[:timeout])
    result["checks"] << { "id" => "version", **probe }
    result["installed"] = probe["status"] == "ok" || system("which", metadata["command"], out: File::NULL, err: File::NULL)
  else
    paths = Array(metadata["app_paths"]).map { |path| expand_path(path) }
    result["installed"] = paths.any? { |path| File.exist?(path) }
    result["checks"] << { "id" => "app", "status" => result["installed"] ? "ok" : "not-installed", "detail" => result["installed"] ? "desktop app present" : "desktop app missing" }
  end
  config_path = config_path_for(metadata)
  result["configured"] = !config_path.empty? && File.exist?(config_path)
  result["checks"] << { "id" => "config", "status" => result["configured"] ? "ok" : "warn", "detail" => result["configured"] ? config_path : "config root missing" }

  case name
  when "openclaw"
    wrapper = File.join(Dir.home, ".local", "bin", "openclaw-gateway-with-omlx")
    gateway = File.executable?(wrapper) ? wrapper : File.join(ROOT, "bin", "openclaw-runtime")
    result["checks"] << { "id" => "gateway", **command_result([gateway, "gateway", "health", "--json"], options[:timeout]) }
  when "claude"
    skills = File.join(Dir.home, ".claude", "skills")
    result["checks"] << { "id" => "skills", **command_result(["claude", "plugin", "validate", skills], options[:timeout]) } if File.directory?(skills)
  when "opencode"
    result["checks"] << { "id" => "mcp", **command_result(["opencode", "mcp", "list"], options[:timeout]) }
  when "vscode"
    user_root = if RUBY_PLATFORM.include?("darwin")
                  File.join(Dir.home, "Library", "Application Support", "Code", "User")
                else
                  File.join(Dir.home, ".config", "Code", "User")
                end
    mcp = File.join(user_root, "mcp.json")
    result["checks"] << { "id" => "mcp", "status" => File.file?(mcp) ? "ok" : "warn", "detail" => File.file?(mcp) ? "MCP file present" : "MCP file missing" }
  end
  results[name] = result
end

providers = {
  "1password" => secret_available?("omlx") ? { "status" => "ok", "detail" => "authenticated with oMLX item" } : { "status" => "warn", "detail" => "not authenticated or oMLX item missing" },
  "omlx" => stored_http_result(ENV.fetch("OMLX_BASE_URL", "http://127.0.0.1:8000/v1"), "/models", "omlx", options[:timeout]),
  "ollama" => http_result(ENV.fetch("OLLAMA_HOST", "http://127.0.0.1:11434").sub(%r{/v1\z}, ""), "/api/tags"),
  "omniroute" => stored_http_result(ENV.fetch("OMNIROUTE_BASE_URL", "http://127.0.0.1:20128"), "/v1/models", "omniroute", options[:timeout]),
}

all_checks = results.values.flat_map { |result| result["checks"] } + providers.values
summary = all_checks.group_by { |check| check["status"] }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["not-installed"] ||= 0
payload = { "schema_version" => 1, "summary" => summary, "harnesses" => results, "providers" => providers }
if options[:json]
  puts JSON.pretty_generate(payload)
else
  results.each do |name, result|
    puts "#{name}: #{result["installed"] ? "installed" : "missing"}, #{result["configured"] ? "configured" : "not configured"}"
    result["checks"].each { |check| puts "  #{check["status"] == "ok" ? "✓" : "!"} #{check["id"]}: #{check["detail"]}" }
  end
  puts "providers:"
  providers.each { |name, check| puts "  #{check["status"] == "ok" ? "✓" : "!"} #{name}: #{check["detail"]}" }
end
exit 1 if summary.fetch("error", 0).positive?
