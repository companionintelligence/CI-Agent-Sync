#!/usr/bin/env ruby

require "json"
require "net/http"
require "open3"
require "optparse"
require "time"
require "uri"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)

options = { json: false, strict: false }
OptionParser.new do |parser|
  parser.banner = "Usage: doctor.rb [--json] [--strict]"
  parser.on("--json", "print machine-readable output") { options[:json] = true }
  parser.on("--strict", "return nonzero for warnings") { options[:strict] = true }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

checks = []

def add_check(checks, id, status, detail, **extra)
  checks << { "id" => id, "status" => status, "detail" => detail }.merge(extra)
end

def run_command(*command)
  output, _error, status = Open3.capture3(*command)
  [output.lines.first.to_s.strip, status.success?]
rescue Errno::ENOENT
  ["", false]
end

def op_secret_value(provider)
  return nil if ENV["AGENT_CONFIGS_SECRET_BACKEND"] == "native"
  binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
  return nil unless system("which", binary, out: File::NULL, err: File::NULL)
  _whoami, _whoami_error, whoami_status = Open3.capture3(binary, "whoami", "--format=json")
  return nil unless whoami_status.success?
  vault = ENV.fetch("AGENT_CONFIGS_OP_VAULT", "Agent Configs")
  item = "agent-configs-#{provider}"
  reference = "op://#{vault}/#{item}/credential"
  output, _error, status = Open3.capture3(binary, "read", "--no-newline", reference)
  output.strip if status.success? && !output.strip.empty?
rescue StandardError
  nil
end

def secret_value(provider)
  op_value = op_secret_value(provider)
  return op_value if op_value

  service = "agent-configs/#{provider}"
  if RUBY_PLATFORM.include?("darwin") && system("which", "security", out: File::NULL, err: File::NULL)
    output, _error, status = Open3.capture3("security", "find-generic-password", "-a", ENV.fetch("USER", ""), "-s", service, "-w")
    return output.strip if status.success? && !output.strip.empty?
  elsif RUBY_PLATFORM.include?("linux") && system("which", "secret-tool", out: File::NULL, err: File::NULL)
    output, _error, status = Open3.capture3("secret-tool", "lookup", "service", service, "account", ENV.fetch("USER", ""))
    return output.strip if status.success? && !output.strip.empty?
  end
  nil
rescue StandardError
  nil
end

def expand_path(value, ci_root)
  value.to_s.gsub("${CI_ROOT}", ci_root).gsub("${HOME}", Dir.home)
end

def http_status(url, path, headers = {})
  uri = URI.join(url.end_with?("/") ? url : "#{url}/", path.delete_prefix("/"))
  http = Net::HTTP.new(uri.host, uri.port)
  http.use_ssl = uri.scheme == "https"
  http.open_timeout = 2
  http.read_timeout = 3
  request = Net::HTTP::Get.new(uri.request_uri)
  headers.each { |key, value| request[key] = value }
  response = http.request(request)
  response.code.to_i
rescue StandardError => error
  "unreachable: #{error.class}"
end

%w[git ruby rg].each do |command|
  path = `command -v #{command} 2>/dev/null`.strip
  if path.empty?
    add_check(checks, "command.#{command}", "error", "not installed")
  else
    version, _ok = run_command(command, "--version")
    add_check(checks, "command.#{command}", "ok", [version, path].reject(&:empty?).join(" — "))
  end
end

%w[code hermes openclaw claude codex opencode ollama npx uvx pnpm yarn docker].each do |command|
  path = `command -v #{command} 2>/dev/null`.strip
  if path.empty?
    add_check(checks, "command.#{command}", "warn", "not installed on this machine")
  else
    version, _ok = run_command(command, "--version")
    add_check(checks, "command.#{command}", "ok", [version, path].reject(&:empty?).join(" — "))
  end
end

config_paths = {
  "hermes" => File.join(Dir.home, ".hermes", "config.yaml"),
  "openclaw" => File.join(Dir.home, ".openclaw", "openclaw.json"),
  "claude" => File.join(Dir.home, ".claude"),
  "codex" => File.join(Dir.home, ".codex"),
  "opencode" => File.join(Dir.home, ".config", "opencode"),
  "ollama" => File.join(Dir.home, ".ollama"),
  "aider-desk" => File.join(Dir.home, "Library", "Application Support", "aider-desk"),
  "antigravity" => File.join(Dir.home, ".gemini", "antigravity"),
  "pi" => File.join(Dir.home, ".pi"),
}
if system("command", "-v", "hermes", out: File::NULL, err: File::NULL)
  hermes_path, _error, hermes_status = Open3.capture3("hermes", "config", "path")
  config_paths["hermes"] = hermes_path.strip if hermes_status.success? && !hermes_path.strip.empty?
end
config_paths.each do |name, path|
  add_check(checks, "config.#{name}", File.exist?(path) ? "ok" : "warn", File.exist?(path) ? "present" : "missing")
end

if command = `command -v openclaw 2>/dev/null`.strip
  gateway_command = File.join(Dir.home, ".local", "bin", "openclaw-gateway-with-omlx")
  gateway_command = command unless File.executable?(gateway_command)
  gateway_probe, gateway_ok = run_command(gateway_command, "gateway", "health", "--json")
  add_check(checks, "runtime.openclaw.gateway", gateway_ok ? "ok" : "warn", gateway_ok ? "gateway health responded" : "gateway probe failed; use the desktop-matched runtime when installed")
end

providers = %w[anthropic openai openrouter ollama omlx companion-hub companion-memory omniroute android-mcp]
op_binary = ENV.fetch("AGENT_CONFIGS_OP_BINARY", "op")
if system("which", op_binary, out: File::NULL, err: File::NULL)
  _whoami, _whoami_error, whoami_status = Open3.capture3(op_binary, "whoami", "--format=json")
  if whoami_status.success?
    add_check(checks, "credential-backend.onepassword", "ok", "1Password CLI authenticated; values are never printed")
  else
    add_check(checks, "credential-backend.onepassword", "warn", "1Password CLI installed but not authenticated")
  end
else
  add_check(checks, "credential-backend.onepassword", "warn", "1Password CLI is not installed")
end
if RUBY_PLATFORM.include?("darwin") && system("command -v security >/dev/null 2>&1")
  providers.each do |provider|
    service = "agent-configs/#{provider}"
    present = system("security", "find-generic-password", "-a", ENV.fetch("USER", ""), "-s", service, out: File::NULL, err: File::NULL)
    op_present = !op_secret_value(provider).nil?
    status = op_present ? "ok" : (present ? "warn" : "warn")
    detail = op_present ? "present in 1Password" : (present ? "present only in Keychain migration source" : "not set; values are never printed")
    add_check(checks, "credential.#{provider}", status, detail)
  end
elsif RUBY_PLATFORM.include?("linux") && system("command -v secret-tool >/dev/null 2>&1")
  providers.each do |provider|
    service = "agent-configs/#{provider}"
    present = system("secret-tool", "lookup", "service", service, "account", ENV.fetch("USER", ""), out: File::NULL, err: File::NULL)
    op_present = !op_secret_value(provider).nil?
    status = op_present ? "ok" : "warn"
    detail = op_present ? "present in 1Password" : (present ? "present only in Linux Secret Service migration source" : "not set; values are never printed")
    add_check(checks, "credential.#{provider}", status, detail)
  end
else
  add_check(checks, "credentials", "info", "native secret store check unavailable on this platform")
end

begin
  examples = [
    File.join(STORE_ROOT, "integrations", "vscode", "settings.json.example"),
    File.join(STORE_ROOT, "integrations", "vscode", "mcp.json.example"),
  ]
  examples.each { |path| JSON.parse(File.read(path)) }
  %w[providers/providers.yaml providers/onepassword.yaml integrations/mcp/registry.yaml integrations/capability-bundles.yaml integrations/harnesses.yaml integrations/providers/routing.yaml integrations/providers/fallbacks.yaml repos/companionintelligence.yaml repos/workspace.yaml].each do |relative|
    YAML.safe_load_file(File.join(STORE_ROOT, relative), aliases: true)
  end
  add_check(checks, "store.manifests", "ok", "YAML and JSON templates parse")
rescue StandardError => error
  add_check(checks, "store.manifests", "error", "parse failure: #{error.class}: #{error.message}")
end

vscode_user_root = if RUBY_PLATFORM.include?("darwin")
                     File.join(Dir.home, "Library", "Application Support", "Code", "User")
                   elsif RUBY_PLATFORM.include?("linux")
                     File.join(Dir.home, ".config", "Code", "User")
                   else
                     File.join(ENV.fetch("APPDATA", Dir.home), "Code", "User")
                   end
vscode_mcp = File.join(vscode_user_root, "mcp.json")
if File.file?(vscode_mcp)
  begin
    data = JSON.parse(File.read(vscode_mcp))
    names = data.fetch("servers", {}).keys
    add_check(checks, "vscode.mcp", "ok", "#{names.length} configured server(s)")
  rescue StandardError => error
    add_check(checks, "vscode.mcp", "error", "invalid JSON: #{error.class}")
  end
else
  add_check(checks, "vscode.mcp", "warn", "user MCP config missing")
end

ollama_url = ENV.fetch("OLLAMA_HOST", "http://127.0.0.1:11434").sub(%r{/v1\z}, "")
omlx_url = ENV.fetch("OMLX_BASE_URL", "http://127.0.0.1:8000").sub(%r{/v1\z}, "")
omniroute_url = ENV.fetch("OMNIROUTE_BASE_URL", "http://127.0.0.1:20128")
ollama_code = http_status(ollama_url, "/api/tags")
add_check(checks, "runtime.ollama", ollama_code == 200 ? "ok" : "warn", "HTTP #{ollama_code}")
omlx_key = secret_value("omlx")
omlx_headers = omlx_key ? { "Authorization" => "Bearer #{omlx_key}" } : {}
omlx_code = http_status(omlx_url, "/v1/models", omlx_headers)
omlx_detail = if omlx_code == 401
                "HTTP 401; local oMLX endpoint is up and needs its access key"
              elsif omlx_key && omlx_code == 200
                "HTTP 200; authenticated with the native secret store"
              else
                "HTTP #{omlx_code}"
              end
add_check(checks, "runtime.omlx", [200, 401].include?(omlx_code) ? "ok" : "warn", omlx_detail)

gateway_host = URI.parse(omniroute_url).host rescue nil
gateway_binding = %w[127.0.0.1 localhost].include?(gateway_host)
add_check(checks, "runtime.omniroute.binding", gateway_binding ? "ok" : "error", gateway_host ? "bound to #{gateway_host}" : "invalid endpoint")
omniroute_key = secret_value("omniroute")
omniroute_headers = omniroute_key ? { "Authorization" => "Bearer #{omniroute_key}" } : {}
gateway_code = http_status(omniroute_url, "/v1/models", omniroute_headers)
gateway_detail = gateway_code == 401 ? "HTTP 401; gateway is protected and needs its access key" : "HTTP #{gateway_code}"
add_check(checks, "runtime.omniroute.models", gateway_code == 200 ? "ok" : "warn", gateway_detail)

hub_url = ENV["COMPANION_HUB_BASE_URL"] || ENV["CI_SERVER_URL"]
if hub_url && !hub_url.empty?
  hub_key = secret_value("companion-hub")
  hub_headers = hub_key ? { "Authorization" => "Bearer #{hub_key}" } : {}
  hub_code = http_status(hub_url, "/api/health", hub_headers)
  add_check(checks, "runtime.companion-hub", hub_code == 200 ? "ok" : "warn", "HTTP #{hub_code}")
else
  add_check(checks, "runtime.companion-hub", "warn", "COMPANION_HUB_BASE_URL/CI_SERVER_URL is not configured")
end

memory_url = ENV["COMPANION_MEMORY_BASE_URL"]
if memory_url && !memory_url.empty?
  memory_key = secret_value("companion-memory")
  memory_headers = memory_key ? { "Authorization" => "Bearer #{memory_key}" } : {}
  memory_code = http_status(memory_url, "/api/health", memory_headers)
  add_check(checks, "runtime.companion-memory", memory_code == 200 ? "ok" : "warn", "HTTP #{memory_code}")
else
  add_check(checks, "runtime.companion-memory", "warn", "COMPANION_MEMORY_BASE_URL is not configured")
end

ci_root = ENV.fetch("CI_ROOT", File.join(Dir.home, "devel", "ci"))
manifest = YAML.safe_load_file(File.join(STORE_ROOT, "repos", "companionintelligence.yaml"), aliases: true)
present = 0
dirty = 0
missing = 0
manifest.fetch("repositories").each do |repo|
  path = expand_path(repo.fetch("local_path"), ci_root)
  if !Dir.exist?(File.join(path, ".git"))
    missing += 1
    next
  end
  present += 1
  status_output, _error, status = Open3.capture3("git", "-C", path, "status", "--porcelain")
  dirty += 1 if status.success? && !status_output.empty?
end
repo_status = dirty.zero? ? "ok" : "warn"
add_check(checks, "workspace.repositories", repo_status, "#{present} present, #{dirty} dirty, #{missing} missing")

summary = checks.group_by { |check| check["status"] }.transform_values(&:length)
result = {
  "schema_version" => 1,
  "generated_at" => Time.now.utc.iso8601,
  "summary" => summary,
  "checks" => checks,
}

if options[:json]
  puts JSON.pretty_generate(result)
else
  puts "Agent store doctor"
  puts ""
  checks.each do |check|
    icon = { "ok" => "✓", "warn" => "!", "error" => "✗", "info" => "·" }.fetch(check["status"])
    puts "#{icon} #{check["id"]}: #{check["detail"]}"
  end
  puts ""
  puts "Summary: #{summary.fetch("ok", 0)} ok, #{summary.fetch("warn", 0)} warnings, #{summary.fetch("error", 0)} errors"
end

exit 1 if summary.fetch("error", 0).positive? || (options[:strict] && summary.fetch("warn", 0).positive?)
