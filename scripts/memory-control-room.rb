#!/usr/bin/env ruby

# Read-only Companion Memory probe. The default URL is the Caddy origin created
# by `make dev` in the local Companion-Memory checkout. It never reads memory
# records and never invokes an intent or mutation tool.

require "json"
require "net/http"
require "openssl"
require "optparse"
require "timeout"
require "uri"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
options = {
  json: false,
  strict: false,
  from_1password: false,
  mcp: true,
  base_url: ENV.fetch("COMPANION_MEMORY_BASE_URL", "https://companion-memory.localhost"),
  timeout: 8,
}

OptionParser.new do |parser|
  parser.banner = "Usage: memory-control-room.rb [options]"
  parser.on("--json") { options[:json] = true }
  parser.on("--strict") { options[:strict] = true }
  parser.on("--from-1password") { options[:from_1password] = true }
  parser.on("--no-mcp") { options[:mcp] = false }
  parser.on("--base-url URL") { |value| options[:base_url] = value }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def add_check(checks, id, status, detail, **extra)
  checks << { "id" => id, "status" => status, "detail" => detail }.merge(extra)
end

def memory_uri(base_url, path)
  URI.join(base_url.end_with?("/") ? base_url : "#{base_url}/", path.delete_prefix("/"))
end

def request(base_url, path, headers: {}, method: :get, body: nil, timeout_seconds: 8)
  uri = memory_uri(base_url, path)
  klass = method == :post ? Net::HTTP::Post : Net::HTTP::Get
  req = klass.new(uri.request_uri)
  headers.each { |key, value| req[key] = value }
  req.body = body if body
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  # Caddy's local *.localhost certificate is intentionally not in every Ruby
  # trust store. Relax verification only for the local development origin;
  # remote HTTPS endpoints still use normal certificate verification.
  if http.use_ssl? && (uri.host == "localhost" || uri.host.end_with?(".localhost"))
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE
    http.verify_hostname = false if http.respond_to?(:verify_hostname=)
  end
  http.open_timeout = [timeout_seconds, 2].min
  http.read_timeout = timeout_seconds
  response = nil
  Timeout.timeout(timeout_seconds + 1) { response = http.request(req) }
  { code: response.code.to_i, body: response.body.to_s, headers: response.each_header.to_h }
rescue StandardError => error
  { code: nil, body: "", headers: {}, error: error.class.to_s }
end

def capture_secret(provider, env_name, from_1password)
  direct = ENV[env_name].to_s
  return direct unless direct.empty?
  return nil unless from_1password

  command = [File.join(ROOT, "bin", "agent-store"), "with", provider, "--", RbConfig.ruby, "-e", "print ENV.fetch(ARGV.fetch(0))", env_name]
  output, _error, status = AgentConfigProcess.capture_with_timeout(command, 35)
  return nil unless status&.success?

  output.strip.empty? ? nil : output.strip
rescue StandardError
  nil
end

def auth_headers(key)
  key && !key.empty? ? { "Authorization" => "Bearer #{key}" } : {}
end

def parse_json_or_sse(body)
  parsed = JSON.parse(body)
  return parsed
rescue JSON::ParserError
  body.to_s.lines.reverse_each do |line|
    next unless line.start_with?("data:")

    begin
      return JSON.parse(line.delete_prefix("data:").strip)
    rescue JSON::ParserError
      next
    end
  end
  nil
end

def response_detail(response)
  response[:code] ? "HTTP #{response[:code]}" : "unreachable (#{response[:error]})"
end

def mcp_probe(base_url, key, timeout_seconds)
  headers = auth_headers(key).merge(
    "Content-Type" => "application/json",
    "Accept" => "application/json, text/event-stream",
  )
  initialize_body = JSON.generate(
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-configs-memory-control-room", version: "1" } },
  )
  initialized = request(base_url, "/api/mcp", headers: headers, method: :post, body: initialize_body, timeout_seconds: timeout_seconds)
  return { ok: false, detail: response_detail(initialized) } unless initialized[:code] == 200

  session_id = initialized[:headers]["mcp-session-id"].to_s
  listed = request(
    base_url,
    "/api/mcp",
    headers: headers.merge("Mcp-Session-Id" => session_id),
    method: :post,
    body: JSON.generate(jsonrpc: "2.0", id: 2, method: "tools/list", params: {}),
    timeout_seconds: timeout_seconds,
  )
  return { ok: false, detail: "tools/list #{response_detail(listed)}" } unless listed[:code] == 200

  payload = parse_json_or_sse(listed[:body])
  tools = payload&.dig("result", "tools")
  return { ok: false, detail: "tools/list returned no tool array" } unless tools.is_a?(Array)

  { ok: true, detail: "#{tools.length} tool(s) advertised", tool_count: tools.length }
rescue StandardError => error
  { ok: false, detail: "MCP #{error.class}" }
end

checks = []
base_url = options[:base_url].to_s.chomp("/")

health = request(base_url, "/api/health", timeout_seconds: options[:timeout])
add_check(checks, "memory.health", health[:code] == 200 ? "ok" : "error", response_detail(health), path: "/api/health", http_status: health[:code])

detailed = request(base_url, "/api/health/detailed", timeout_seconds: options[:timeout])
detailed_payload = JSON.parse(detailed[:body]) rescue nil
detailed_status = if detailed[:code] != 200
                    detailed[:code] ? "warn" : "error"
                  elsif detailed_payload.is_a?(Hash) && detailed_payload["ok"] == false
                    "warn"
                  else
                    "ok"
                  end
detailed_detail = response_detail(detailed)
detailed_detail += "; dependencies report degraded" if detailed_payload.is_a?(Hash) && detailed_payload["ok"] == false
add_check(checks, "memory.health.detailed", detailed_status, detailed_detail, path: "/api/health/detailed", http_status: detailed[:code])

key = capture_secret("companion-memory", "COMPANION_MEMORY_API_KEY", options[:from_1password])
if key.nil? || key.empty?
  add_check(checks, "memory.intents", "warn", "memory key unavailable; create agent-configs-companion-memory", path: "/api/agent/intents")
else
  intents = request(base_url, "/api/agent/intents", headers: auth_headers(key), timeout_seconds: options[:timeout])
  add_check(checks, "memory.intents", intents[:code] == 200 ? "ok" : "error", response_detail(intents), path: "/api/agent/intents", http_status: intents[:code])
end

if options[:mcp]
  if key.nil? || key.empty?
    add_check(checks, "memory.mcp.handshake", "warn", "memory key unavailable; skipped MCP handshake", path: "/api/mcp")
  else
    result = mcp_probe(base_url, key, options[:timeout])
    add_check(checks, "memory.mcp.handshake", result[:ok] ? "ok" : "error", result[:detail], path: "/api/mcp", tool_count: result[:tool_count])
  end
end

summary = checks.group_by { |check| check["status"] }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["error"] ||= 0
result = { "schema_version" => 1, "memory_base_url" => base_url, "mode" => "read_only", "summary" => summary, "checks" => checks }

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Companion Memory control room (read-only)"
  checks.each do |check|
    icon = check["status"] == "ok" ? "✓" : (check["status"] == "error" ? "✗" : "!")
    puts "#{icon} #{check["id"]}: #{check["detail"]}"
  end
  puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
end

exit 1 if summary["error"].positive? || (options[:strict] && summary["warn"].positive?)
