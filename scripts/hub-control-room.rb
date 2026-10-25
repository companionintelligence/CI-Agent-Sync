#!/usr/bin/env ruby

# Read-only Companion Hub operator/control-room probe. This script deliberately
# does not call lifecycle, pairing, registration, backup, model-load, or settings
# mutation endpoints. It may retrieve scoped keys from 1Password into child-process
# memory when --from-1password is explicit; no key or response body is printed.

require "json"
require "net/http"
require "open3"
require "optparse"
require "timeout"
require "uri"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)

options = {
  json: false,
  strict: false,
  from_1password: false,
  cli: true,
  mcp: true,
  inference: true,
  base_url: ENV.fetch("COMPANION_HUB_BASE_URL", "http://127.0.0.1:5002"),
  timeout: 8,
}

OptionParser.new do |parser|
  parser.banner = "Usage: hub-control-room.rb [options]"
  parser.on("--json", "print machine-readable output") { options[:json] = true }
  parser.on("--strict", "return nonzero for warnings or errors") { options[:strict] = true }
  parser.on("--from-1password", "load scoped Hub keys through agent-store") { options[:from_1password] = true }
  parser.on("--base-url URL", "Hub origin (default: COMPANION_HUB_BASE_URL or localhost:5002)") { |value| options[:base_url] = value }
  parser.on("--timeout SECONDS", Integer, "per-request timeout") { |value| options[:timeout] = value }
  parser.on("--no-cli", "skip cihub status") { options[:cli] = false }
  parser.on("--no-mcp", "skip MCP handshake") { options[:mcp] = false }
  parser.on("--no-inference", "skip inference model inventory") { options[:inference] = false }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def add_check(checks, id, status, detail, **extra)
  checks << { "id" => id, "status" => status, "detail" => detail }.merge(extra)
end

def hub_uri(base_url, path)
  URI.join(base_url.end_with?("/") ? base_url : "#{base_url}/", path.delete_prefix("/"))
end

def http_request(base_url, path, headers: {}, method: :get, body: nil, timeout_seconds: 8)
  uri = hub_uri(base_url, path)
  request_class = { get: Net::HTTP::Get, post: Net::HTTP::Post }.fetch(method)
  request = request_class.new(uri.request_uri)
  headers.each { |key, value| request[key] = value }
  request.body = body if body
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = [timeout_seconds, 2].min
  http.read_timeout = timeout_seconds
  response = nil
  Timeout.timeout(timeout_seconds + 1) { response = http.request(request) }
  {
    code: response.code.to_i,
    body: response.body.to_s,
    headers: response.each_header.to_h,
  }
rescue StandardError => error
  { code: nil, body: "", headers: {}, error: error.class.to_s }
end

def secret_value(provider, env_name, from_1password)
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

def status_detail(response)
  return "unreachable (#{response[:error]})" unless response[:code]

  "HTTP #{response[:code]}"
end

def probe_get(checks, base_url, id, path, key: nil, missing_detail: "scoped credential unavailable", timeout_seconds: 8, allow: [200], severity: :warn)
  if key.nil? || key.empty?
    add_check(checks, id, "warn", missing_detail, path: path)
    return nil
  end
  response = http_request(base_url, path, headers: auth_headers(key), timeout_seconds: timeout_seconds)
  status = allow.include?(response[:code]) ? "ok" : (response[:code] == 401 || response[:code] == 403 ? "error" : severity.to_s)
  add_check(checks, id, status, status_detail(response), path: path, http_status: response[:code])
  response
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

def mcp_probe(base_url, key, timeout_seconds)
  headers = {
    "Authorization" => "Bearer #{key}",
    "Content-Type" => "application/json",
    "Accept" => "application/json, text/event-stream",
  }
  initialize_body = JSON.generate(
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-configs-control-room", version: "1" },
    },
  )
  initialized = http_request(base_url, "/api/mcp", headers: headers, method: :post, body: initialize_body, timeout_seconds: timeout_seconds)
  return { ok: false, detail: status_detail(initialized) } unless initialized[:code] == 200

  session_id = initialized[:headers]["mcp-session-id"]
  list_headers = headers.merge("Mcp-Session-Id" => session_id.to_s)
  listed = http_request(
    base_url,
    "/api/mcp",
    headers: list_headers,
    method: :post,
    body: JSON.generate(jsonrpc: "2.0", id: 2, method: "tools/list", params: {}),
    timeout_seconds: timeout_seconds,
  )
  return { ok: false, detail: "tools/list #{status_detail(listed)}" } unless listed[:code] == 200

  payload = parse_json_or_sse(listed[:body])
  tools = payload&.dig("result", "tools")
  return { ok: false, detail: "tools/list returned no tool array" } unless tools.is_a?(Array)

  { ok: true, detail: "#{tools.length} tool(s) advertised", tool_count: tools.length, session: !session_id.to_s.empty? }
rescue StandardError => error
  { ok: false, detail: "MCP #{error.class}" }
end

checks = []
base_url = options[:base_url].to_s.chomp("/")

live = http_request(base_url, "/api/health/live", timeout_seconds: options[:timeout])
add_check(checks, "hub.health.live", live[:code] == 200 ? "ok" : "error", status_detail(live), path: "/api/health/live", http_status: live[:code])

ready = http_request(base_url, "/api/health", timeout_seconds: options[:timeout])
ready_status = ready[:code] == 200 ? "ok" : (ready[:code] ? "warn" : "error")
add_check(checks, "hub.health.ready", ready_status, status_detail(ready), path: "/api/health", http_status: ready[:code])

phase = http_request(base_url, "/api/registration/phase", timeout_seconds: options[:timeout])
phase_status = phase[:code] == 200 ? "ok" : (phase[:code] ? "warn" : "error")
add_check(checks, "hub.registration.phase", phase_status, status_detail(phase), path: "/api/registration/phase", http_status: phase[:code])

drift = http_request(base_url, "/api/registration/state-drift", timeout_seconds: options[:timeout])
drift_status = drift[:code] == 200 ? "ok" : (drift[:code] ? "warn" : "error")
add_check(checks, "hub.registration.state-drift", drift_status, status_detail(drift), path: "/api/registration/state-drift", http_status: drift[:code])

qa_key = secret_value("companion-hub-qa", "COMPANION_HUB_QA_API_KEY", options[:from_1password])
probe_get(checks, base_url, "hub.qa.pool-status", "/api/inference/pool/status", key: qa_key, timeout_seconds: options[:timeout], missing_detail: "qa:read key unavailable; create agent-configs-companion-hub-qa")
probe_get(checks, base_url, "hub.qa.routing-log", "/api/inference/pool/routing-log", key: qa_key, timeout_seconds: options[:timeout], missing_detail: "qa:read key unavailable; skipped with pool status")
probe_get(checks, base_url, "hub.qa.install-queue", "/api/apps/install-queue", key: qa_key, timeout_seconds: options[:timeout], missing_detail: "qa:read key unavailable; skipped with pool status")

if options[:inference]
  inference_key = secret_value("companion-hub-inference", "COMPANION_HUB_INFERENCE_API_KEY", options[:from_1password])
  models = probe_get(checks, base_url, "hub.inference.models", "/api/inference/v1/models", key: inference_key, timeout_seconds: options[:timeout], missing_detail: "inference key unavailable; create agent-configs-companion-hub-inference")
  if models && models[:code] == 200
    payload = JSON.parse(models[:body]) rescue nil
    count = payload.is_a?(Hash) && payload["data"].is_a?(Array) ? payload["data"].length : nil
    checks.last["detail"] = "HTTP 200; #{count || "unknown"} model(s)" if count
  end
end

if options[:mcp]
  mcp_key = secret_value("companion-hub", "COMPANION_HUB_API_KEY", options[:from_1password])
  if mcp_key.nil? || mcp_key.empty?
    add_check(checks, "hub.mcp.handshake", "warn", "mcp key unavailable; create agent-configs-companion-hub", path: "/api/mcp")
  else
    result = mcp_probe(base_url, mcp_key, options[:timeout])
    add_check(checks, "hub.mcp.handshake", result[:ok] ? "ok" : "error", result[:detail], path: "/api/mcp", tool_count: result[:tool_count])
  end
end

if options[:cli]
  output, _error, status = AgentConfigProcess.capture_with_timeout(["cihub", "status"], [options[:timeout], 15].max)
  detail = if status&.success?
             line = output.lines.find { |entry| entry.include?("Hub status") || entry.include?("Dashboard") }
             line ? line.strip : "cihub status succeeded"
           else
             status.nil? ? "cihub status timed out" : "cihub status failed"
           end
  add_check(checks, "hub.cli.status", status&.success? ? "ok" : "warn", detail)
end

summary = checks.group_by { |item| item["status"] }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["error"] ||= 0
result = {
  "schema_version" => 1,
  "hub_base_url" => base_url,
  "mode" => "read_only",
  "summary" => summary,
  "checks" => checks,
}

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Companion Hub control room (read-only)"
  checks.each do |check|
    icon = check["status"] == "ok" ? "✓" : (check["status"] == "error" ? "✗" : "!")
    puts "#{icon} #{check["id"]}: #{check["detail"]}"
  end
  puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
end

exit 1 if summary["error"].positive? || (options[:strict] && summary["warn"].positive?)
