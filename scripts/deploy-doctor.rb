#!/usr/bin/env ruby

# Read-only deployment preflight. It never deploys, publishes, updates a
# fleet, or writes a secret.

require "json"
require "optparse"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)
options = { json: false, strict: false, from_1password: false, fleet: false, timeout: 20 }

OptionParser.new do |parser|
  parser.banner = "Usage: deploy-doctor.rb [--json] [--strict] [--from-1password] [--fleet]"
  parser.on("--json") { options[:json] = true }
  parser.on("--strict") { options[:strict] = true }
  parser.on("--from-1password") { options[:from_1password] = true }
  parser.on("--fleet") { options[:fleet] = true }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def add_check(checks, id, status, detail)
  checks << { "id" => id, "status" => status, "detail" => detail }
end

def capture(command, timeout_seconds)
  AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
end

def executable(name)
  `command -v #{name} 2>/dev/null`.strip
end

def first_safe_line(output)
  output.to_s.lines.map(&:strip).reject(&:empty?).reject { |line| line.match?(/token|secret|api.?key|password|authorization/i) }.first.to_s[0, 220]
end

checks = []
wrangler = executable("wrangler")
if wrangler.empty?
  add_check(checks, "cloudflare.wrangler", "warn", "wrangler is not installed or not on PATH")
else
  command = if options[:from_1password]
              [File.join(ROOT, "bin", "agent-store"), "with", "cloudflare", "--", wrangler, "whoami"]
            else
              [wrangler, "whoami"]
            end
  output, _error, status = capture(command, options[:timeout])
  if status.nil?
    add_check(checks, "cloudflare.identity", "warn", "wrangler whoami timed out")
  elsif status.success?
    detail = first_safe_line(output)
    prefix = options[:from_1password] ? "Wrangler API-token identity verified" : "Wrangler native OAuth identity verified"
    add_check(checks, "cloudflare.identity", "ok", "#{prefix}#{detail.empty? ? "" : ": #{detail}"}")
  else
    detail = options[:from_1password] ? "portable Cloudflare token unavailable or rejected" : "native Wrangler OAuth is not authenticated"
    add_check(checks, "cloudflare.identity", "warn", detail)
  end
end

cihub = executable("cihub")
if cihub.empty?
  add_check(checks, "hub.cli", "warn", "cihub is not installed or not on PATH")
else
  output, _error, status = capture([cihub, "status"], options[:timeout])
  detail = if status.nil?
             "cihub status timed out"
           elsif status.success?
             first_safe_line(output).empty? ? "cihub status succeeded" : first_safe_line(output)
           else
             "cihub status failed"
           end
  add_check(checks, "hub.local.status", status&.success? ? "ok" : "warn", detail)
end

agentctl = File.join(ROOT, "bin", "agentctl")
output, _error, status = capture([agentctl, "hub", "smoke", "--json", "--no-cli", "--no-mcp", "--no-inference"], options[:timeout])
hub_payload = JSON.parse(output) rescue nil
if hub_payload.is_a?(Hash)
  summary = hub_payload.fetch("summary", {})
  status_name = summary.fetch("error", 0).to_i.positive? ? "error" : (summary.fetch("warn", 0).to_i.positive? ? "warn" : "ok")
  add_check(checks, "hub.local.control-room", status_name, "#{summary.fetch("ok", 0)} ok, #{summary.fetch("warn", 0)} warnings, #{summary.fetch("error", 0)} errors")
else
  add_check(checks, "hub.local.control-room", status.nil? ? "error" : "warn", "control-room probe returned no JSON")
end

memory_output, _memory_error, memory_status = capture([agentctl, "memory", "smoke", "--json", "--no-mcp"], options[:timeout])
memory_payload = JSON.parse(memory_output) rescue nil
if memory_payload.is_a?(Hash)
  summary = memory_payload.fetch("summary", {})
  status_name = summary.fetch("error", 0).to_i.positive? ? "error" : (summary.fetch("warn", 0).to_i.positive? ? "warn" : "ok")
  add_check(checks, "memory.local.control-room", status_name, "#{summary.fetch("ok", 0)} ok, #{summary.fetch("warn", 0)} warnings, #{summary.fetch("error", 0)} errors")
else
  add_check(checks, "memory.local.control-room", memory_status.nil? ? "error" : "warn", "memory probe returned no JSON")
end

tailscale = executable("tailscale")
if tailscale.empty?
  add_check(checks, "tailscale.identity", "warn", "tailscale CLI is not installed or not on PATH")
else
  output, _error, status = capture([tailscale, "status", "--json"], options[:timeout])
  data = JSON.parse(output) rescue nil
  if status&.success? && data.is_a?(Hash)
    peers = data.fetch("Peer", {}).values
    online = peers.count { |peer| peer["Online"] }
    add_check(checks, "tailscale.identity", "ok", "#{online} online peer(s); self=#{data.dig("Self", "HostName")}")
  else
    add_check(checks, "tailscale.identity", status.nil? ? "warn" : "error", status.nil? ? "tailscale status timed out" : "tailscale status failed")
  end
end

if options[:fleet]
  output, _error, status = capture([agentctl, "fleet", "smoke", "--json"], [options[:timeout], 30].max)
  payload = JSON.parse(output) rescue nil
  if payload.is_a?(Hash)
    summary = payload.fetch("summary", {})
    status_name = summary.fetch("error", 0).to_i.positive? ? "error" : (summary.fetch("warn", 0).to_i.positive? ? "warn" : "ok")
    add_check(checks, "hub.fleet.smoke", status_name, "#{summary.fetch("ok", 0)} ok, #{summary.fetch("warn", 0)} warnings, #{summary.fetch("error", 0)} errors")
  else
    add_check(checks, "hub.fleet.smoke", status.nil? ? "error" : "warn", "fleet probe returned no JSON")
  end
end

summary = checks.group_by { |check| check["status"] }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["error"] ||= 0
result = { "schema_version" => 1, "mode" => "read_only_preflight", "summary" => summary, "checks" => checks }

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Deployment doctor (read-only)"
  checks.each do |check|
    icon = check["status"] == "ok" ? "✓" : (check["status"] == "error" ? "✗" : "!")
    puts "#{icon} #{check["id"]}: #{check["detail"]}"
  end
  puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
end

exit 1 if summary["error"].positive? || (options[:strict] && summary["warn"].positive?)
