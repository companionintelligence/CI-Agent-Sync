#!/usr/bin/env ruby

require "json"
require "open3"
require "tmpdir"

root = File.expand_path("..", __dir__)
script = File.join(root, "scripts", "action-ledger.rb")

Dir.mktmpdir("agent-configs-ledger-test") do |ledger_root|
  env = { "AGENT_CONFIGS_LEDGER_ROOT" => ledger_root, "USER" => "test-user" }
  run = lambda do |*args|
    output, error, status = Open3.capture3(env, RbConfig.ruby, script, *args)
    abort "ledger command failed: #{args.join(" ")}\n#{output}\n#{error}" unless status.success?
    JSON.parse(output)
  end

  pending = run.call("plan", "--json", "--action", "marketplace_full_qa", "--target", "core-1", "--reason", "release test")
  raise "plan was not pending" unless pending["status"] == "pending"
  id = pending.fetch("id")

  _out, _err, refused = Open3.capture3(env, RbConfig.ruby, script, "approve", "--id", id)
  raise "approval without confirmation was accepted" if refused.success?

  approved = run.call("approve", "--json", "--id", id, "--confirm")
  raise "approval did not record" unless approved["status"] == "approved"
  completed = run.call("complete", "--json", "--id", id, "--result", "passed")
  raise "completion did not record" unless completed["status"] == "completed" && completed["result"] == "passed"
  listed = run.call("list", "--json")
  raise "list did not return completed record" unless listed.any? { |record| record["id"] == id && record["status"] == "completed" }
end

puts "action ledger tests: ok"
