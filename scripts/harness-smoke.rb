#!/usr/bin/env ruby

require "json"
require "net/http"
require "open3"
require "optparse"
require "timeout"
require "uri"
require "yaml"
require_relative "process_helpers"
require_relative "harness_probe"

ROOT = File.expand_path("..", __dir__)
options = { json: false, live_local: false, agent: nil, timeout: 12 }
OptionParser.new do |parser|
  parser.banner = "Usage: harness-smoke.rb [--json] [--live-local] [--agent NAME] [--timeout SECONDS]"
  parser.on("--json") { options[:json] = true }
  parser.on("--live-local") { options[:live_local] = true }
  parser.on("--agent NAME") { |value| options[:agent] = value }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!
options[:timeout] = [[options[:timeout], 1].max, 300].min

def expand_path(value)
  value.to_s
    .gsub("${HOME}", Dir.home)
    .gsub("${USERPROFILE}", ENV.fetch("USERPROFILE", Dir.home))
    .gsub("${APPDATA}", ENV.fetch("APPDATA", File.join(Dir.home, "Library", "Application Support")))
end

$agent_config_op_items = nil
$agent_config_op_secrets = {}

def onepassword_item_names(timeout_seconds = 12)
  return $agent_config_op_items unless $agent_config_op_items.nil?

  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
  output, _error, status = capture_with_timeout([binary, "item", "list", "--vault", vault, "--format=json"], timeout_seconds)
  parsed = JSON.parse(output) rescue []
  $agent_config_op_items = status&.success? ? Array(parsed).filter_map { |item| item["title"] || item["id"] } : []
rescue StandardError
  $agent_config_op_items = []
end

def op_secret_value(provider, timeout_seconds = 12)
  return $agent_config_op_secrets[provider] if $agent_config_op_secrets.key?(provider)
  $agent_config_op_secrets[provider] = nil
  return nil if ENV["AGENT_CONFIGS_SECRET_BACKEND"] == "native"
  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  return nil unless system("which", binary, out: File::NULL, err: File::NULL)
  vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
  return nil unless onepassword_item_names(timeout_seconds).include?("agent-configs-#{provider}")
  reference = "op://#{vault}/agent-configs-#{provider}/credential"
  output, _error, status = capture_with_timeout([binary, "read", "--no-newline", reference], timeout_seconds)
  return nil if status.nil?
  value = status.success? && !output.strip.empty? ? output.strip : nil
  $agent_config_op_secrets[provider] = value
  value
rescue Timeout::Error, StandardError
  nil
end

def secret_value(provider, timeout_seconds = 12)
  op_value = op_secret_value(provider, timeout_seconds)
  return op_value if op_value

  service = "agent-configs/#{provider}"
  if RUBY_PLATFORM.include?("darwin") && system("command", "-v", "security", out: File::NULL, err: File::NULL)
    out, _err, status = capture_with_timeout(["security", "find-generic-password", "-a", ENV.fetch("USER", ""), "-s", service, "-w"], timeout_seconds)
    return out.strip if status&.success? && !out.strip.empty?
  elsif RUBY_PLATFORM.include?("linux") && system("command", "-v", "secret-tool", out: File::NULL, err: File::NULL)
    out, _err, status = capture_with_timeout(["secret-tool", "lookup", "service", service, "account", ENV.fetch("USER", "")], timeout_seconds)
    return out.strip if status&.success? && !out.strip.empty?
  end
  nil
rescue StandardError
  nil
end

def command_probe(command, timeout_seconds)
  output, _error, status = capture_with_timeout(command, timeout_seconds)
  return { "status" => "warn", "detail" => "timed out" } if status.nil?
  detail = output.to_s.lines.map(&:strip).find { |line| !line.empty? }.to_s
  if output.to_s.lstrip.start_with?("{")
    parsed = JSON.parse(output) rescue nil
    detail = parsed["ok"] == true ? "healthy" : detail if parsed.is_a?(Hash)
  end
  { "status" => status.success? ? "ok" : "warn", "detail" => detail }
rescue Errno::ENOENT
  { "status" => "not-installed", "detail" => "command not found" }
rescue StandardError => error
  { "status" => "warn", "detail" => error.class.to_s }
end

def capture_with_timeout(command, timeout_seconds)
  AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
end

def http_probe(base, path, headers = {}, timeout_seconds = 8)
  uri = URI.join(base.end_with?("/") ? base : "#{base}/", path.delete_prefix("/"))
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = [timeout_seconds, 3].min
  http.read_timeout = timeout_seconds
  request = Net::HTTP::Get.new(uri.request_uri)
  headers.each { |key, value| request[key] = value }
  response = http.request(request)
  { "code" => response.code.to_i, "status" => response.code.to_i == 200 ? "ok" : "warn" }
rescue StandardError => error
  { "code" => nil, "status" => "warn", "detail" => error.class.to_s }
end

harnesses = YAML.safe_load_file(File.join(ROOT, "integrations", "harnesses.yaml"), aliases: false).fetch("harnesses")
selected = options[:agent] ? { options[:agent] => harnesses.fetch(options[:agent]) } : harnesses
checks = []
selected.each do |name, metadata|
  if metadata["command"]
    command = metadata["command"] == "openclaw" ? File.join(ROOT, "bin", "openclaw-runtime") : metadata["command"]
    probe = command_probe(AgentConfigHarnessProbe.command_for(metadata, command), options[:timeout])
    checks << { "id" => "harness.#{name}.command", "status" => probe["status"], "detail" => probe["detail"] }
  elsif Array(metadata["app_paths"]).any? { |path| File.exist?(expand_path(path)) }
    checks << { "id" => "harness.#{name}.app", "status" => "ok", "detail" => "desktop app present" }
  else
    checks << { "id" => "harness.#{name}.app", "status" => "not-installed", "detail" => "desktop app not found" }
  end
  platform = RUBY_PLATFORM.include?("darwin") ? "macos" : (RUBY_PLATFORM.include?("linux") ? "linux" : "windows")
  path = metadata.dig("config_paths", platform)
  present = path && File.exist?(expand_path(path))
  checks << { "id" => "harness.#{name}.config", "status" => present ? "ok" : "warn", "detail" => present ? "config root present" : "config root not found" }
end

ollama = ENV.fetch("OLLAMA_HOST", "http://127.0.0.1:11434").sub(%r{/v1\z}, "")
omlx = ENV.fetch("OMLX_BASE_URL", "http://127.0.0.1:8000/v1")
omniroute = ENV.fetch("OMNIROUTE_BASE_URL", "http://127.0.0.1:20128")
[
  ["runtime.ollama", ollama, "/api/tags", nil],
  ["runtime.omlx", omlx.sub(%r{/v1\z}, ""), "/v1/models", secret_value("omlx", options[:timeout])],
  ["runtime.omniroute", omniroute, "/v1/models", secret_value("omniroute", options[:timeout])],
].each do |id, base, path, key|
  probe = http_probe(base, path, key ? { "Authorization" => "Bearer #{key}" } : {}, options[:timeout])
  detail = probe["detail"] || "HTTP #{probe["code"] || "unreachable"}"
  detail = "#{detail}; reachable but authentication is missing" if probe["code"] == 401
  checks << { "id" => id, "status" => probe["status"], "detail" => detail }
end

if options[:live_local]
  if selected.key?("openclaw") || !options[:agent]
    gateway_wrapper = File.join(Dir.home, ".local", "bin", "openclaw-gateway-with-omlx")
    gateway_command = File.executable?(gateway_wrapper) ? [gateway_wrapper, "gateway", "health", "--json"] : ["openclaw", "gateway", "health", "--json"]
    probe = command_probe(gateway_command, options[:timeout])
    checks << { "id" => "live.openclaw.gateway", "status" => probe["status"], "detail" => probe["detail"] }
  end
  key = secret_value("omlx", options[:timeout])
  model = ENV.fetch("AGENTCTL_LOCAL_MODEL", "Qwen3.8-27B-oQ4e-fp16-mtp")
  if key
    begin
      uri = URI.join(omlx.end_with?("/") ? omlx : "#{omlx}/", "chat/completions")
      http = Net::HTTP.new(uri.host, uri.port)
      http.open_timeout = 3
      http.read_timeout = options[:timeout]
      request = Net::HTTP::Post.new(uri.request_uri)
      request["Authorization"] = "Bearer #{key}"
      request["Content-Type"] = "application/json"
      request.body = JSON.generate("model" => model, "messages" => [{ "role" => "user", "content" => "Return only the exact result of 2+2." }], "temperature" => 0, "max_tokens" => 64, "chat_template_kwargs" => { "enable_thinking" => false })
      response = nil
      started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      Timeout.timeout(options[:timeout]) { response = http.request(request) }
      elapsed = (Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).round(2)
      body = JSON.parse(response.body) rescue {}
      message = body.dig("choices", 0, "message") || {}
      content = (message["content"] || body.dig("choices", 0, "text") || body["response"] || body["output"]).to_s
      answer_ok = content.include?("4")
      status = response.code.to_i == 200 && answer_ok ? "ok" : "error"
      detail = "oMLX #{model} HTTP #{response.code} in #{elapsed}s; harmless coding answer matched=#{answer_ok}; content not recorded"
      checks << { "id" => "live.local.coding", "status" => status, "detail" => detail }
    rescue StandardError => error
      checks << { "id" => "live.local.coding", "status" => "error", "detail" => error.class.to_s }
    end
  else
    checks << { "id" => "live.local.coding", "status" => "warn", "detail" => "oMLX credential is not present; skipped authenticated coding request" }
  end
end

summary = checks.group_by { |item| item["status"] }.transform_values(&:length)
result = { "schema_version" => 1, "summary" => summary, "checks" => checks, "live_local" => options[:live_local] }
if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Harness smoke checks"
  checks.each do |item|
    icon = item["status"] == "ok" ? "✓" : (item["status"] == "error" ? "✗" : "!")
    puts "#{icon} #{item["id"]}: #{item["detail"]}"
  end
  puts "Summary: #{summary.fetch("ok", 0)} ok, #{summary.fetch("warn", 0)} warnings, #{summary.fetch("error", 0)} errors"
end
exit 1 if summary.fetch("error", 0).positive?
