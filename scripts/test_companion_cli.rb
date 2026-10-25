#!/usr/bin/env ruby

require "json"
require "open3"
require "tmpdir"

root = File.expand_path("..", __dir__)
script = File.join(root, "scripts", "companion-cli.rb")

def write_executable(path, body)
  File.write(path, "#!/bin/sh\nset -eu\n#{body}\n")
  File.chmod(0o755, path)
end

Dir.mktmpdir("agent-atlas-companion-cli") do |directory|
  hub = File.join(directory, "fake-cihub")
  memory = File.join(directory, "fake-ci")
  write_executable(hub, 'printf "%s\\n" "Hub status [local]" "Tailscale VPN active"')
  write_executable(memory, 'printf "%s\\n" ' + "'" + '{"ok":true,"me":{"id":"user-1","name":"CEO"}}' + "'")

  env = {
    "CIHUB_BIN" => hub,
    "CI_MEMORY_CLI" => memory,
    "PATH" => ENV.fetch("PATH", ""),
    "COMPANION_MEMORY_BASE_URL" => "http://127.0.0.1:3030",
  }
  output, error, status = Open3.capture3(env, RbConfig.ruby, script, "status", "--json")
  abort "status command failed: #{error}" unless status.success?
  payload = JSON.parse(output)
  raise "wrong schema" unless payload["schema_version"] == 1
  raise "native bridge mode missing" unless payload["mode"] == "native_cli_bridge"
  raise "expected two services" unless payload["services"].length == 2
  raise "Hub fixture did not pass" unless payload.dig("services", 0, "status") == "ok"
  raise "Memory fixture did not pass" unless payload.fetch("services").any? { |item| item["id"] == "companion-memory" && item["status"] == "ok" }
  raise "credential leaked" if output.match?(/api[_-]?key|Bearer\s+[^\s]+/i)

  output, error, status = Open3.capture3(env, RbConfig.ruby, script, "memory", "status")
  abort "memory alias failed: #{error}" unless status.success?
  raise "memory alias did not forward doctor" unless output.include?("{\"ok\":true")

  output, error, status = Open3.capture3(env, RbConfig.ruby, script, "hub", "status", "local")
  abort "Hub passthrough failed: #{error}" unless status.success?
  raise "Hub passthrough did not run" unless output.include?("Hub status [local]")

  output, error, status = Open3.capture3(env, RbConfig.ruby, script, "tui", stdin_data: "1\nq\n")
  abort "TUI fixture failed: #{error}" unless status.success?
  raise "TUI menu did not render" unless output.include?("Companion Intelligence TUI")
  raise "TUI did not run combined status" unless output.include?("Companion CLI status")
end

puts "companion CLI fixture: ok"
