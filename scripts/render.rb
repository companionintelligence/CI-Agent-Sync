#!/usr/bin/env ruby

require "fileutils"
require "json"
require "optparse"
require "open3"
require "time"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
DEFAULT_OUTPUT = File.join(STORE_ROOT, "local", "rendered")

options = { agent: "all", machine: "auto", output: DEFAULT_OUTPUT }
OptionParser.new do |parser|
  parser.banner = "Usage: render.rb [--agent NAME] [--machine NAME] [--output PATH]"
  parser.on("--agent NAME", "vscode, workspace, or all") { |value| options[:agent] = value }
  parser.on("--machine NAME", "machine profile name") { |value| options[:machine] = value }
  parser.on("--output PATH", "ignored/generated output directory") { |value| options[:output] = File.expand_path(value) }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def read_yaml(path)
  YAML.safe_load(File.read(path), aliases: true) || {}
end

def expand_path(value, ci_root)
  value.to_s.gsub("${CI_ROOT}", ci_root).gsub("${HOME}", Dir.home)
end

def replace_machine_paths(value, ci_root, machine_paths)
  return value.map { |item| replace_machine_paths(item, ci_root, machine_paths) } if value.is_a?(Array)
  if value.is_a?(Hash)
    return value.transform_values { |item| replace_machine_paths(item, ci_root, machine_paths) }
  end
  return value unless value.is_a?(String)

  result = expand_path(value, ci_root)
  machine_paths.each do |name, path|
    result = result.gsub("${#{name.upcase}_ROOT}", path) if path
  end
  result
end

def write_file(path, content)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, content)
end

def copy_file(source, destination)
  FileUtils.mkdir_p(File.dirname(destination))
  FileUtils.cp(source, destination)
end

def extension_ids(path)
  File.readlines(path, chomp: true).filter_map do |line|
    line = line.strip
    next if line.empty? || line.start_with?("#")

    line.split("@", 2).first
  end
end

def command_output(*command)
  output, _error, status = Open3.capture3(*command)
  status.success? ? output.strip : nil
rescue Errno::ENOENT
  nil
end

root = STORE_ROOT
output_root = options[:output]
detected_machine = if RUBY_PLATFORM.include?("darwin")
                     "macos-laptop"
                   elsif RUBY_PLATFORM.include?("linux")
                     "linux-workstation"
                   else
                     "windows-workstation"
                   end
machine_name = options[:machine] == "auto" ? detected_machine : options[:machine]
overlay = File.join(root, "profiles", "machines", "local.yaml")
profile = File.join(root, "profiles", "machines", "#{machine_name}.yaml.example")
machine_config = if File.file?(overlay)
                   read_yaml(overlay)
                 elsif File.file?(profile)
                   read_yaml(profile)
                 else
                   {}
                 end
profile_root = machine_config.dig("paths", "ci_root")
profile_root = expand_path(profile_root, File.join(Dir.home, "devel", "ci")) if profile_root
ci_root = ENV.fetch("CI_ROOT", profile_root || File.join(Dir.home, "devel", "ci"))
repos = read_yaml(File.join(root, "repos", "companionintelligence.yaml")).fetch("repositories")
workspace = read_yaml(File.join(root, "repos", "workspace.yaml"))
capability_bundles = read_yaml(File.join(root, "integrations", "capability-bundles.yaml"))
all_workspace_names = workspace.fetch("layers").values.flatten.uniq
repo_by_name = repos.each_with_object({}) { |repo, memo| memo[repo.fetch("name")] = repo }
repos.each do |repo|
  Array(repo["aliases"]).each { |alias_name| repo_by_name[alias_name] = repo }
end
machine_path_values = machine_config.fetch("paths", {}).transform_values { |path| expand_path(path, ci_root) }
repo_path_overrides = {
  "Companion-Hub" => "companion_hub",
  "Companion-Memory" => "companion_memory",
  "CI-Hub" => "companion_hub",
  "CI-Server" => "companion_memory",
  "CI-Engineering" => "ci_engineering",
}

workspace_repositories = all_workspace_names.map do |name|
  repo = repo_by_name[name]
  override = repo_path_overrides[name]
  path = if override && machine_path_values[override]
           machine_path_values.fetch(override)
         elsif repo
           expand_path(repo.fetch("local_path"), ci_root)
         elsif (workspace.fetch("local_paths", {})[name])
           expand_path(workspace.fetch("local_paths").fetch(name), ci_root)
         else
           File.join(ci_root, name)
         end
  { "name" => name, "path" => path, "exists" => Dir.exist?(path) }
end

requested = options[:agent]
allowed = %w[all vscode workspace aider-desk]
abort "Unknown agent: #{requested}; choose #{allowed.join(", ")}" unless allowed.include?(requested)

if requested == "all"
  FileUtils.rm_rf(output_root)
else
  FileUtils.rm_rf(File.join(output_root, requested))
end
FileUtils.mkdir_p(output_root)

outputs = []
record = lambda do |path|
  outputs << path.delete_prefix("#{output_root}/")
end

if requested == "all" || requested == "vscode"
  vscode_root = File.join(output_root, "vscode")
  copy_file(File.join(root, "integrations", "vscode", "settings.json.example"), File.join(vscode_root, "settings.json"))
  copy_file(File.join(root, "integrations", "vscode", "mcp.json.example"), File.join(vscode_root, "mcp.json"))
  ids = extension_ids(File.join(root, "integrations", "vscode", "extensions.txt"))
  write_file(File.join(vscode_root, "extensions.txt"), ids.join("\n") + "\n")
  %w[settings.json mcp.json extensions.txt].each { |name| record.call("vscode/#{name}") }
end

if requested == "all" || requested == "workspace"
  workspace_root = File.join(output_root, "workspace")
  settings = {
    "files.exclude" => { "**/.env*" => true, "**/node_modules" => true, "**/target" => true, "**/.turbo" => true },
    "search.exclude" => { "**/node_modules" => true, "**/dist" => true, "**/build" => true, "**/.yarn/cache" => true },
  }
  recommendations = extension_ids(File.join(root, "integrations", "vscode", "extensions.txt"))
  base_workspace = {
    "folders" => workspace_repositories.map { |repo| { "name" => repo["name"], "path" => repo["path"] } },
    "settings" => settings,
    "extensions" => { "recommendations" => recommendations },
  }
  local_workspace = base_workspace.merge(
    "folders" => workspace_repositories.select { |repo| repo["exists"] }.map { |repo| { "name" => repo["name"], "path" => repo["path"] } },
  )
  write_file(File.join(workspace_root, "companion-intelligence.code-workspace"), JSON.pretty_generate(base_workspace) + "\n")
  write_file(File.join(workspace_root, "companion-intelligence.local.code-workspace"), JSON.pretty_generate(local_workspace) + "\n")
  write_file(File.join(workspace_root, "repository-status.json"), JSON.pretty_generate(workspace_repositories) + "\n")
  readme = <<~MARKDOWN
    # Generated Companion Intelligence workspace

    Generated: #{Time.now.utc.iso8601}

    - `companion-intelligence.code-workspace` includes the full layer map.
    - `companion-intelligence.local.code-workspace` includes only existing checkouts.
    - `repository-status.json` records presence only; it contains no credentials.

    This directory is generated and ignored. Edit the manifests under `repos/`
    instead of editing these files directly.
  MARKDOWN
  write_file(File.join(workspace_root, "README.md"), readme)
  %w[companion-intelligence.code-workspace companion-intelligence.local.code-workspace repository-status.json README.md].each do |name|
    record.call("workspace/#{name}")
  end
end

if requested == "all" || requested == "aider-desk"
  aider_desk_root = File.join(output_root, "aider-desk")
  template_path = File.join(root, "integrations", "aider-desk", "mcp-servers.json.example")
  template = JSON.parse(File.read(template_path))
  machine_paths = machine_path_values.dup
  machine_paths["ci_root"] = ci_root
  rendered = replace_machine_paths(template, ci_root, machine_paths)
  write_file(File.join(aider_desk_root, "mcp-servers.json"), JSON.pretty_generate(rendered) + "\n")
  write_file(File.join(aider_desk_root, "README.md"), <<~MARKDOWN)
    # Generated Aider Desk configuration

    Copy `mcp-servers.json` to `~/Library/Application Support/aider-desk/` after
    reviewing the resolved machine paths. API keys and OAuth sessions are not
    included; Metricool authorization remains native to Aider Desk.
  MARKDOWN
  record.call("aider-desk/mcp-servers.json")
  record.call("aider-desk/README.md")
end

if requested == "all"
  client_root = File.join(output_root, "clients")
  clients = {
    "hermes" => ["~/.hermes/config.yaml", "./bin/agent-store with <provider> -- hermes"],
    "openclaw" => ["~/.openclaw/openclaw.json", "./bin/agent-store with companion-hub -- openclaw"],
    "claude" => ["~/.claude", "./bin/agent-store with anthropic -- claude"],
    "codex" => ["~/.codex", "./bin/agent-store with openai -- codex"],
    "opencode" => ["~/.config/opencode/opencode.jsonc", "./bin/agent-store with omniroute -- opencode"],
    "aider-desk" => ["~/Library/Application Support/aider-desk", "configure provider in the desktop UI"],
    "antigravity" => ["~/.gemini/antigravity", "configure provider in the desktop UI"],
    "pi" => ["~/.pi", "configure provider in the desktop UI"],
  }
  clients.each do |name, (config_path, launch) |
    default_bundles = Array(capability_bundles.dig("client_defaults", name))
    body = <<~MARKDOWN
      # #{name}

      Native configuration: `#{config_path}`

      Provider launch example: `#{launch}`

      Default reviewed MCP bundles: `#{default_bundles.empty? ? "none (opt in)" : default_bundles.join(", ")}`

      Native OAuth/session files and app databases are intentionally not
      generated or copied. Run `./bin/agent-store audit #{name}` after setup.
    MARKDOWN
    write_file(File.join(client_root, "#{name}.md"), body)
    record.call("clients/#{name}.md")
  end
  copy_file(File.join(root, "integrations", "capability-bundles.yaml"), File.join(client_root, "capability-bundles.yaml"))
  copy_file(File.join(root, "integrations", "harnesses.yaml"), File.join(client_root, "harnesses.yaml"))
  record.call("clients/capability-bundles.yaml")
  record.call("clients/harnesses.yaml")
end

metadata = {
  "schema_version" => 1,
  "generated_at" => Time.now.utc.iso8601,
  "machine" => machine_name,
  "agent" => requested,
  "source_commit" => command_output("git", "-C", root, "rev-parse", "--short", "HEAD"),
  "outputs" => outputs,
}
write_file(File.join(output_root, "manifest.json"), JSON.pretty_generate(metadata) + "\n")

puts "Generated #{outputs.length} portable artifacts under #{output_root}"
