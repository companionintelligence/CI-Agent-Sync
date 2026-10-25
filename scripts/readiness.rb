#!/usr/bin/env ruby

# Aggregate the local agent, Companion Hub, Companion Memory, Tailscale fleet,
# and optional Cloudflare read-only checks into one machine-readable report.
# Child probes already own their credentials and redaction rules; this file
# only carries their JSON summaries and never prints their stderr or secrets.

require "json"
require "net/http"
require "optparse"
require "time"
require "uri"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)

options = { json: false, strict: false, from_1password: false, deploy: false, timeout: 20 }
OptionParser.new do |parser|
  parser.banner = "Usage: readiness.rb [--json] [--strict] [--from-1password] [--deploy] [--timeout SECONDS]"
  parser.on("--json") { options[:json] = true }
  parser.on("--strict") { options[:strict] = true }
  parser.on("--from-1password") { options[:from_1password] = true }
  parser.on("--deploy", "include Cloudflare and local deployment checks") { options[:deploy] = true }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def run_json(script, args, timeout_seconds)
  command = [RbConfig.ruby, File.join(ROOT, "scripts", script), "--json", *args]
  output, _error, status = AgentConfigProcess.capture_with_timeout(command, timeout_seconds)
  payload = JSON.parse(output) rescue nil
  return [payload, status&.success?] if payload.is_a?(Hash)

  [{
    "schema_version" => 1,
    "summary" => { "error" => 1 },
    "checks" => [{
      "id" => "runner.#{script}",
      "status" => "error",
      "detail" => status.nil? ? "probe timed out" : "probe returned no JSON",
    }],
  }, false]
rescue StandardError => error
  [{
    "schema_version" => 1,
    "summary" => { "error" => 1 },
    "checks" => [{ "id" => "runner.#{script}", "status" => "error", "detail" => "probe failed: #{error.class}" }],
  }, false]
end

def surface_status(payload)
  summary = payload.fetch("summary", {})
  return "error" if summary.fetch("error", 0).to_i.positive?
  return "warn" if summary.fetch("warn", 0).to_i.positive?

  "ok"
end

def surface_checks(payload)
  checks = payload["checks"]
  return checks if checks.is_a?(Array)

  payload.fetch("harnesses", {}).flat_map do |name, record|
    Array(record["checks"]).map { |check| check.merge("id" => "harness.#{name}.#{check.fetch("id", "check")}") }
  end
end

def fleet_qa_surface
  base = ENV["CI_FLEET_QA_URL"].to_s.strip
  return nil if base.empty?

  uri = URI.join(base.end_with?("/") ? base : "#{base}/", "api/readiness.json")
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = 5
  http.read_timeout = 15
  response = http.get(uri.request_uri)
  payload = JSON.parse(response.body) rescue nil
  unless payload.is_a?(Hash)
    return {
      "status" => "error",
      "command" => "GET #{uri.scheme}://#{uri.host}:#{uri.port}/api/readiness.json",
      "child_ok" => false,
      "summary" => { "error" => 1 },
      "checks" => [{ "id" => "fleet_qa.readiness", "status" => "error", "detail" => "fleet-qa returned no JSON (HTTP #{response.code})" }],
    }
  end
  checks = Array(payload["checks"]).map do |check|
    status = case check["level"]
             when "block" then "error"
             when "warn" then "warn"
             else "ok"
             end
    check.merge("id" => "fleet_qa.#{check.fetch("id", "check")}", "status" => status)
  end
  {
    "status" => payload["ready"] == false ? (checks.any? { |check| check["status"] == "error" } ? "error" : "warn") : "ok",
    "command" => "GET #{uri.scheme}://#{uri.host}:#{uri.port}/api/readiness.json",
    "child_ok" => response.is_a?(Net::HTTPSuccess),
    "summary" => { "ok" => checks.count { |check| check["status"] == "ok" }, "warn" => checks.count { |check| check["status"] == "warn" }, "error" => checks.count { |check| check["status"] == "error" } },
    "checks" => checks,
    "run" => payload["run"],
  }
rescue StandardError => error
  {
    "status" => "error",
    "command" => "GET fleet-qa/api/readiness.json",
    "child_ok" => false,
    "summary" => { "error" => 1 },
    "checks" => [{ "id" => "fleet_qa.readiness", "status" => "error", "detail" => "fleet-qa probe failed: #{error.class}" }],
  }
end

surfaces = {}
surface_commands = {
  "agent_store" => ["doctor.rb", []],
  "companion_hub" => ["hub-control-room.rb", ["--no-cli"]],
  "companion_memory" => ["memory-control-room.rb", []],
  "tailscale_fleet" => ["hub-fleet-smoke.rb", []],
}
surface_commands["cloudflare"] = ["deploy-doctor.rb", []] if options[:deploy]

surface_commands.each do |name, (script, args)|
  child_args = args.dup
  if options[:from_1password] && %w[hub-control-room.rb memory-control-room.rb deploy-doctor.rb].include?(script)
    child_args << "--from-1password"
  end
  payload, child_ok = run_json(script, child_args, [options[:timeout], 60].max)
  surfaces[name] = {
    "status" => surface_status(payload),
    "command" => ["scripts/#{script}", *child_args].join(" "),
    "child_ok" => child_ok,
    "summary" => payload.fetch("summary", {}),
    "checks" => surface_checks(payload),
  }
end

fleet_qa = fleet_qa_surface
surfaces["fleet_qa"] = fleet_qa if fleet_qa

checks = surfaces.values.flat_map { |surface| surface.fetch("checks", []) }
summary = checks.group_by { |check| check.fetch("status", "warn") }.transform_values(&:length)
summary["ok"] ||= 0
summary["warn"] ||= 0
summary["error"] ||= 0
blocking = checks.select { |check| check["status"] == "error" }
warnings = checks.select { |check| check["status"] == "warn" || check["status"] == "not-installed" }
ready = blocking.empty? && warnings.empty?

next_actions = (blocking + warnings).map do |check|
  detail = check.fetch("detail", "needs attention").to_s[0, 220]
  "#{check.fetch("id", "check")}: #{detail}"
end.uniq.first(50)

result = {
  "schema_version" => 1,
  "observed_at" => Time.now.utc.iso8601,
  "mode" => "read_only_aggregate",
  "ready" => ready,
  "strict" => options[:strict],
  "summary" => summary,
  "surfaces" => surfaces,
  "blocking" => blocking,
  "warnings" => warnings,
  "next_actions" => next_actions,
}

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Companion Intelligence readiness (read-only)"
  puts "Ready: #{ready ? "yes" : "no"}"
  surfaces.each { |name, surface| puts "#{surface["status"] == "ok" ? "✓" : "!"} #{name}: #{surface["status"]}" }
  next_actions.each { |action| puts "  - #{action}" }
  puts "Summary: #{summary["ok"]} ok, #{summary["warn"]} warnings, #{summary["error"]} errors"
end

exit 1 if summary["error"].positive? || (options[:strict] && !ready)
