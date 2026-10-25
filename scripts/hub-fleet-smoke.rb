#!/usr/bin/env ruby

# Read-only anonymous Hub fleet reachability probe. It verifies Tailscale
# naming and the Hub liveness route; it deliberately does not pair nodes,
# inspect private fleet state, or mutate any remote machine.

require "json"
require "net/http"
require "optparse"
require "timeout"
require "uri"
require "yaml"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
TARGETS_PATH = File.join(ROOT, "integrations", "fleet", "targets.yaml")

options = { json: false, strict: false, include_candidates: false, timeout: 6, targets: nil }
OptionParser.new do |parser|
  parser.banner = "Usage: hub-fleet-smoke.rb [--json] [--strict] [--include-candidates] [--target NAME[,NAME...]]"
  parser.on("--json") { options[:json] = true }
  parser.on("--strict") { options[:strict] = true }
  parser.on("--include-candidates") { options[:include_candidates] = true }
  parser.on("--target NAMES", "comma-separated target ids") { |value| options[:targets] = value.split(",").map(&:strip).reject(&:empty?) }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

catalog = YAML.safe_load_file(TARGETS_PATH, aliases: false)
targets = catalog.fetch("targets")
selected = if options[:targets]
             options[:targets].to_h { |name| [name, targets.fetch(name)] }
           else
             targets.select { |_name, target| target["enabled"] || options[:include_candidates] }
           end

def add_check(checks, id, status, detail, **extra)
  checks << { "id" => id, "status" => status, "detail" => detail }.merge(extra)
end

def capture(command, seconds)
  AgentConfigProcess.capture_with_timeout(command, seconds)
end

def http_status(base_url, path, timeout_seconds)
  uri = URI.join(base_url.end_with?("/") ? base_url : "#{base_url}/", path.delete_prefix("/"))
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = [timeout_seconds, 2].min
  http.read_timeout = timeout_seconds
  request = Net::HTTP::Get.new(uri.request_uri)
  response = nil
  Timeout.timeout(timeout_seconds + 1) { response = http.request(request) }
  response.code.to_i
rescue StandardError => error
  { error: error.class.to_s }
end

checks = []
tailscale_path = `command -v tailscale 2>/dev/null`.strip
add_check(checks, "tailscale.command", tailscale_path.empty? ? "warn" : "ok", tailscale_path.empty? ? "tailscale is not installed" : "tailscale CLI available")

selected.each do |name, target|
  tailscale_name = target.fetch("tailscale_name")
  if target["kind"] == "laptop"
    # The local target is intentionally probed through loopback; Tailscale is
    # not needed to reach the service from this process.
  elsif tailscale_path.empty?
    add_check(checks, "fleet.#{name}.tailscale", "warn", "tailscale CLI unavailable", target: name)
  else
    _out, _error, ping_status = capture([tailscale_path, "ping", "--timeout=5s", tailscale_name], [options[:timeout], 5].max)
    ping_detail = if ping_status.nil?
                    "tailscale ping timed out"
                  elsif ping_status.success?
                    "tailscale ping succeeded"
                  else
                    "tailscale ping failed"
                  end
    add_check(checks, "fleet.#{name}.tailscale", ping_status&.success? ? "ok" : "warn", ping_detail, target: name, tailscale_name: tailscale_name)
  end

  code = http_status(target.fetch("base_url"), catalog.fetch("tailnet").fetch("health_path"), options[:timeout])
  if code.is_a?(Integer)
    status = code == 200 ? "ok" : (target["enabled"] ? "error" : "warn")
    detail = "HTTP #{code}"
  else
    status = target["enabled"] ? "error" : "warn"
    detail = "unreachable (#{code[:error]})"
  end
  add_check(checks, "fleet.#{name}.hub-health", status, detail, target: name, base_url: target.fetch("base_url"), http_status: code.is_a?(Integer) ? code : nil)
end

summary = checks.group_by { |check| check["status"] }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["error"] ||= 0
result = {
  "schema_version" => 1,
  "mode" => "read_only_anonymous_health",
  "observed_at" => catalog.fetch("observed_at"),
  "summary" => summary,
  "checks" => checks,
  "targets" => selected.keys,
}

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Companion Hub fleet smoke (read-only)"
  checks.each do |check|
    icon = check["status"] == "ok" ? "✓" : (check["status"] == "error" ? "✗" : "!")
    puts "#{icon} #{check["id"]}: #{check["detail"]}"
  end
  puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
end

exit 1 if summary["error"].positive? || (options[:strict] && summary["warn"].positive?)
