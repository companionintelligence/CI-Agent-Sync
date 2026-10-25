#!/usr/bin/env ruby

require "digest"
require "fileutils"
require "json"
require "open3"
require "optparse"
require "time"

ROOT = File.expand_path("..", __dir__)
options = { dry_run: false, output: File.join(ROOT, "local", "backups", Time.now.utc.strftime("%Y%m%d-%H%M%S")) }
OptionParser.new do |parser|
  parser.banner = "Usage: backup.rb [--dry-run] [--output PATH]"
  parser.on("--dry-run") { options[:dry_run] = true }
  parser.on("--output PATH") { |value| options[:output] = File.expand_path(value) }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

home = Dir.home
hermes_config = File.join(home, ".hermes", "config.yaml")
if system("command", "-v", "hermes", out: File::NULL, err: File::NULL)
  resolved, _error, status = Open3.capture3("hermes", "config", "path")
  hermes_config = resolved.strip if status.success? && !resolved.strip.empty?
end
sources = [
  ["hermes/config.yaml", hermes_config, "yaml"],
  ["openclaw/openclaw.json", File.join(home, ".openclaw", "openclaw.json"), "json"],
  ["claude/settings.json", File.join(home, ".claude", "settings.json"), "json"],
  ["claude/claude.json", File.join(home, ".claude", ".claude.json"), "json"],
  ["codex/config.toml", File.join(home, ".codex", "config.toml"), "text"],
  ["opencode/opencode.jsonc", File.join(home, ".config", "opencode", "opencode.jsonc"), "text"],
  ["aider-desk/config.json", File.join(home, "Library", "Application Support", "aider-desk", "config.json"), "json"],
  ["aider-desk/mcp-servers.json", File.join(home, "Library", "Application Support", "aider-desk", "mcp-servers.json"), "json"],
  ["antigravity/mcp_config.jsonc", File.join(home, ".gemini", "antigravity-ide", "mcp_config.json"), "text"],
  ["pi/models.json", File.join(home, ".pi", "agent", "models.json"), "json"],
  ["pi/models-store.json", File.join(home, ".pi", "agent", "models-store.json"), "json"],
  ["vscode/settings.json", File.join(home, "Library", "Application Support", "Code", "User", "settings.json"), "json"],
  ["vscode/mcp.json", File.join(home, "Library", "Application Support", "Code", "User", "mcp.json"), "json"],
]

if options[:dry_run]
  puts "Backup plan: #{options[:output]}"
  sources.each { |relative, source, _kind| puts "  #{File.file?(source) ? "copy" : "skip"}: #{relative}" }
  exit 0
end

FileUtils.mkdir_p(options[:output])
records = []
sources.each do |relative, source, kind|
  unless File.file?(source)
    records << { "path" => relative, "status" => "missing" }
    next
  end
  destination = File.join(options[:output], relative)
  FileUtils.mkdir_p(File.dirname(destination))
  redactor = kind == "json" || kind == "yaml" ? "redact-config.rb" : "redact-text.rb"
  _out, error, status = Open3.capture3(RbConfig.ruby, File.join(ROOT, "scripts", redactor), source, destination)
  abort "redaction failed for #{source}: #{error}" unless status.success?
  records << { "path" => relative, "status" => "copied-redacted", "sha256" => Digest::SHA256.file(destination).hexdigest }
end

doctor_out, doctor_error, doctor_status = Open3.capture3(File.join(ROOT, "bin", "agentctl"), "doctor", "--json")
File.write(File.join(options[:output], "doctor.json"), doctor_out)
records << { "path" => "doctor.json", "status" => doctor_status.success? ? "ok" : "warnings-or-errors", "stderr_present" => !doctor_error.empty? }
manifest = {
  "schema_version" => 1,
  "created_at" => Time.now.utc.iso8601,
  "redacted" => true,
  "native_auth_and_state_included" => false,
  "files" => records,
}
File.write(File.join(options[:output], "manifest.json"), JSON.pretty_generate(manifest) + "\n")
puts "Created redacted agent backup: #{options[:output]}"
puts "Native credentials, OAuth sessions, app databases, and device identities were not copied."
