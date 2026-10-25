#!/usr/bin/env ruby

# Small local approval ledger. It records intent and approval; it never
# performs the requested mutation. Downstream Hub, Cloudflare, Metricool, and
# fleet callers can require an approved, unexpired record before writing.

require "fileutils"
require "json"
require "optparse"
require "securerandom"
require "time"

ROOT = File.expand_path("..", __dir__)
LEDGER_ROOT = ENV.fetch("AGENT_CONFIGS_LEDGER_ROOT", File.join(ROOT, "local", "action-ledger"))

command = ARGV.shift || "list"
options = { json: false, confirm: false, ttl: 1800, action: nil, target: nil, reason: nil, id: nil, result: nil }
OptionParser.new do |parser|
  parser.banner = "Usage: action-ledger.rb plan|approve|complete|cancel|list [options]"
  parser.on("--json") { options[:json] = true }
  parser.on("--confirm", "required to approve an action") { options[:confirm] = true }
  parser.on("--action ACTION") { |value| options[:action] = value }
  parser.on("--target TARGET") { |value| options[:target] = value }
  parser.on("--reason REASON") { |value| options[:reason] = value }
  parser.on("--id ID") { |value| options[:id] = value }
  parser.on("--result RESULT") { |value| options[:result] = value }
  parser.on("--ttl SECONDS", Integer) { |value| options[:ttl] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def fail_with(message)
  warn message
  exit 2
end

def now
  Time.now.utc
end

def path_for(id)
  File.join(LEDGER_ROOT, "#{id}.json")
end

def load_record(id)
  path = path_for(id)
  fail_with "ledger record not found: #{id}" unless File.file?(path)
  JSON.parse(File.read(path))
rescue JSON::ParserError => error
  fail_with "ledger record is invalid: #{error.message}"
end

def save_record(record)
  FileUtils.mkdir_p(LEDGER_ROOT)
  path = path_for(record.fetch("id"))
  temporary = "#{path}.tmp-#{Process.pid}"
  File.write(temporary, JSON.pretty_generate(record) + "\n", mode: "w", perm: 0o600)
  File.rename(temporary, path)
end

def emit(value, json)
  puts(json ? JSON.pretty_generate(value) : value.inspect)
end

case command
when "plan"
  fail_with "--action is required" if options[:action].to_s.empty?
  fail_with "--target is required" if options[:target].to_s.empty?
  fail_with "--reason is required" if options[:reason].to_s.empty?
  fail_with "--ttl must be positive" unless options[:ttl].positive?
  timestamp = now
  id = "ledger-#{timestamp.strftime("%Y%m%dT%H%M%SZ")}-#{SecureRandom.hex(4)}"
  record = {
    "schema_version" => 1,
    "id" => id,
    "action" => options[:action],
    "target" => options[:target],
    "reason" => options[:reason],
    "requested_at" => timestamp.iso8601,
    "requested_by" => ENV.fetch("USER", "unknown"),
    "status" => "pending",
    "requires_confirmation" => true,
    "expires_at" => (timestamp + options[:ttl]).iso8601,
    "approved_at" => nil,
    "completed_at" => nil,
    "result" => nil,
  }
  save_record(record)
  emit(record, options[:json])
when "approve"
  fail_with "--id is required" if options[:id].to_s.empty?
  fail_with "approval requires --confirm" unless options[:confirm] == true
  record = load_record(options[:id])
  fail_with "only pending actions can be approved" unless record["status"] == "pending"
  if Time.parse(record.fetch("expires_at")) <= now
    record["status"] = "expired"
    save_record(record)
    fail_with "approval window expired"
  end
  record["status"] = "approved"
  record["approved_at"] = now.iso8601
  record["approved_by"] = ENV.fetch("USER", "unknown")
  save_record(record)
  emit(record, options[:json])
when "complete"
  fail_with "--id is required" if options[:id].to_s.empty?
  record = load_record(options[:id])
  fail_with "only approved actions can be completed" unless record["status"] == "approved"
  fail_with "approval window expired" if Time.parse(record.fetch("expires_at")) <= now
  record["status"] = "completed"
  record["completed_at"] = now.iso8601
  record["result"] = options[:result] unless options[:result].to_s.empty?
  save_record(record)
  emit(record, options[:json])
when "cancel"
  fail_with "--id is required" if options[:id].to_s.empty?
  record = load_record(options[:id])
  fail_with "terminal action cannot be cancelled" if %w[completed cancelled expired].include?(record["status"])
  record["status"] = "cancelled"
  record["cancelled_at"] = now.iso8601
  save_record(record)
  emit(record, options[:json])
when "list"
  records = Dir[File.join(LEDGER_ROOT, "ledger-*.json")].filter_map do |path|
    JSON.parse(File.read(path)) rescue nil
  end.sort_by { |record| record.fetch("requested_at", "") }.reverse
  emit(records, options[:json])
else
  fail_with "unknown ledger command: #{command}"
end
