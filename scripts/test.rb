#!/usr/bin/env ruby

require "json"
require "open3"
require "optparse"

root = File.expand_path("..", __dir__)
options = { json: false, live_local: false }
OptionParser.new do |parser|
  parser.banner = "Usage: test.rb [--json] [--live-local]"
  parser.on("--json") { options[:json] = true }
  parser.on("--live-local") { options[:live_local] = true }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

checks = []
def run_check(checks, id, *command)
  output, error, status = Open3.capture3(*command)
  checks << {
    "id" => id,
    "status" => status.success? ? "ok" : "error",
    "detail" => [output, error].join.lines.last(12).join.strip,
  }
end

run_check(checks, "validate", RbConfig.ruby, File.join(root, "scripts", "validate.rb"))
smoke = [RbConfig.ruby, File.join(root, "scripts", "harness-smoke.rb")]
smoke << "--live-local" if options[:live_local]
run_check(checks, "harness-smoke", *smoke)
run_check(checks, "sync-tests", RbConfig.ruby, File.join(root, "scripts", "test_sync.rb"))
run_check(checks, "process-helper-tests", RbConfig.ruby, File.join(root, "scripts", "test_process_helpers.rb"))
run_check(checks, "hub-control-room-fixture", RbConfig.ruby, File.join(root, "scripts", "test_hub_control_room.rb"))
run_check(checks, "memory-control-room-fixture", RbConfig.ruby, File.join(root, "scripts", "test_memory_control_room.rb"))
run_check(checks, "marketplace-audit-fixture", RbConfig.ruby, File.join(root, "scripts", "test_marketplace_audit.rb"))
run_check(checks, "ci-agent-sync-typescript-web-fixture", RbConfig.ruby, File.join(root, "scripts", "test_atlas_web.rb"))
run_check(checks, "companion-cli-fixture", RbConfig.ruby, File.join(root, "scripts", "test_companion_cli.rb"))

summary = checks.group_by { |item| item["status"] }.transform_values(&:length)
result = { "schema_version" => 1, "summary" => summary, "checks" => checks, "live_local" => options[:live_local] }
if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Agent control-plane tests"
  checks.each { |item| puts "#{item["status"] == "ok" ? "✓" : "✗"} #{item["id"]}: #{item["detail"]}" }
  puts "Summary: #{summary.fetch("ok", 0)} ok, #{summary.fetch("error", 0)} errors"
end
exit 1 if summary.fetch("error", 0).positive?
