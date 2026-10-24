#!/usr/bin/env ruby

require "fileutils"
require "open3"
require "tmpdir"

STORE_ROOT = File.expand_path("..", __dir__)
SYNC_COMMAND = File.join(STORE_ROOT, "scripts", "sync.rb")

def run(*args)
  stdout, stderr, status = Open3.capture3(*args)
  abort "command failed: #{args.join(" ")}\n#{stdout}\n#{stderr}" unless status.success?
  stdout
end

Dir.mktmpdir("agent-configs-sync-test") do |root|
  clean = File.join(root, "clean")
  dirty = File.join(root, "dirty")

  [clean, dirty].each do |target|
    run("git", "init", "-q", "-b", "main", target)
    run("git", "-C", target, "config", "user.email", "test@example.invalid")
    run("git", "-C", target, "config", "user.name", "agent-configs test")
    run("git", "-C", target, "commit", "--allow-empty", "-qm", "init")
  end

  FileUtils.touch(File.join(dirty, "uncommitted.txt"))

  plan = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean, "--json")
  abort "clean target did not produce a plan" unless plan.include?("shared/provider-routing")
  abort "plan unexpectedly applied files" if File.exist?(File.join(clean, ".agent-configs"))

  run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean, "--apply")
  expected = File.join(clean, ".agent-configs", "mcp", "registry.yaml")
  abort "manifest item was not applied" unless File.file?(expected)

  run("git", "-C", clean, "add", ".agent-configs")
  run("git", "-C", clean, "commit", "-qm", "test: apply agent config sync")
  stable = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", clean)
  abort "clean target was not stable after apply" unless stable.include?("planned") && !stable.include?("add:")

  dirty_result = run(STORE_ROOT + "/bin/agent-store", "sync", "--target", dirty)
  abort "dirty target was not skipped" unless dirty_result.include?("skipped-dirty")
end

puts "sync smoke tests passed"
