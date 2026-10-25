#!/usr/bin/env ruby

# Write a portable, redacted operator evidence bundle. It deliberately runs
# probes rather than copying native client state, so the result can move to a
# different machine without moving OAuth sessions, device identities, or keys.

require "digest"
require "fileutils"
require "json"
require "optparse"
require "open3"
require "time"
require_relative "process_helpers"

ROOT = File.expand_path("..", __dir__)

options = { json: false, from_1password: false, deploy: false, force: false, output: nil, timeout: 30 }
OptionParser.new do |parser|
  parser.banner = "Usage: export-report.rb [--json] [--from-1password] [--deploy] [--force] [--output PATH]"
  parser.on("--json") { options[:json] = true }
  parser.on("--from-1password") { options[:from_1password] = true }
  parser.on("--deploy") { options[:deploy] = true }
  parser.on("--force", "allow an existing output directory to be replaced") { options[:force] = true }
  parser.on("--output PATH") { |value| options[:output] = File.expand_path(value) }
  parser.on("--timeout SECONDS", Integer) { |value| options[:timeout] = value }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def run_json(script, args, timeout_seconds)
  runner = case script
           when "conformance.rb" then [File.join(ROOT, "bin", "agentctl"), "conformance"]
           when "harness-smoke.rb" then [File.join(ROOT, "bin", "agentctl"), "harness-smoke"]
           else [RbConfig.ruby, File.join(ROOT, "scripts", script)]
           end
  output, error, status = AgentConfigProcess.capture_with_timeout([*runner, "--json", *args], timeout_seconds)
  payload = JSON.parse(output) rescue nil
  return [payload, error, status&.success?] if payload.is_a?(Hash)

  [{ "schema_version" => 1, "summary" => { "error" => 1 }, "error" => status.nil? ? "timed out" : "no JSON returned" }, error, false]
end

timestamp = Time.now.utc.strftime("%Y%m%dT%H%M%SZ")
output_root = options[:output] || File.join(ROOT, "local", "reports", timestamp)
if File.exist?(output_root)
  abort "refusing to overwrite #{output_root}; pass --force or choose --output" unless options[:force]
  FileUtils.rm_rf(output_root)
end
FileUtils.mkdir_p(output_root)

probe_args = []
probe_args << "--from-1password" if options[:from_1password]
probe_args << "--deploy" if options[:deploy]
readiness, readiness_error, readiness_ok = run_json("readiness.rb", probe_args, [options[:timeout], 120].max)
conformance, conformance_error, conformance_ok = run_json("conformance.rb", [], [options[:timeout], 90].max)
smoke, smoke_error, smoke_ok = run_json("harness-smoke.rb", [], [options[:timeout], 90].max)

files = {
  "readiness.json" => readiness,
  "conformance.json" => conformance,
  "harness-smoke.json" => smoke,
}
files.each { |name, payload| File.write(File.join(output_root, name), JSON.pretty_generate(payload) + "\n") }

contract = File.join(ROOT, "integrations", "operator-contract.yaml")
FileUtils.cp(contract, File.join(output_root, "operator-contract.yaml"))

git_commit, _git_error, git_status = Open3.capture3("git", "rev-parse", "HEAD", chdir: ROOT)
git_branch, _branch_error, branch_status = Open3.capture3("git", "branch", "--show-current", chdir: ROOT)
manifest = {
  "schema_version" => 1,
  "created_at" => Time.now.utc.iso8601,
  "redacted" => true,
  "native_state_included" => false,
  "credential_values_included" => false,
  "store_commit" => git_status.success? ? git_commit.strip : nil,
  "store_branch" => branch_status.success? ? git_branch.strip : nil,
  "probe_status" => {
    "readiness" => readiness_ok,
    "conformance" => conformance_ok,
    "harness_smoke" => smoke_ok,
    "stderr_present" => ![readiness_error, conformance_error, smoke_error].all?(&:empty?),
  },
  "files" => files.keys.concat(["operator-contract.yaml"]).map do |name|
    path = File.join(output_root, name)
    { "path" => name, "bytes" => File.size(path), "sha256" => Digest::SHA256.file(path).hexdigest }
  end,
}
File.write(File.join(output_root, "manifest.json"), JSON.pretty_generate(manifest) + "\n")

result = { "ok" => readiness_ok && conformance_ok && smoke_ok, "output" => output_root, "manifest" => manifest }
if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Created redacted operator evidence bundle: #{output_root}"
  puts "Files: #{manifest["files"].length}; native state and credential values were not copied."
end
exit 1 unless result["ok"]
