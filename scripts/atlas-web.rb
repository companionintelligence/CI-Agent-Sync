#!/usr/bin/env ruby

# Agent Atlas is a loopback-only, read-only web console for the portable
# agent-config store. It intentionally has no write endpoints and never loads
# credential values. Mutations remain in the plan/approval CLI workflows.

require "cgi"
require "json"
require "open3"
require "optparse"
require "rbconfig"
require "socket"
require "time"
require "uri"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
WEB_ROOT = File.join(STORE_ROOT, "web")
APP_NAME = "Agent Atlas"
APP_VERSION = "0.1.0"

options = { bind: "127.0.0.1", port: 8787, open: false, check: false, quiet: false, allow_remote: false }
OptionParser.new do |parser|
  parser.banner = "Usage: agent-atlas [--bind ADDRESS] [--port PORT] [--open] [--check]"
  parser.on("--bind ADDRESS", "bind address (default: 127.0.0.1)") { |value| options[:bind] = value }
  parser.on("--port PORT", Integer, "port (default: 8787; use 0 for an ephemeral test port)") { |value| options[:port] = value }
  parser.on("--open", "open the console in the default browser") { options[:open] = true }
  parser.on("--allow-remote", "allow an explicit non-loopback bind; no authentication is added") { options[:allow_remote] = true }
  parser.on("--check", "validate the web assets and exit") { options[:check] = true }
  parser.on("--quiet", "suppress the listening banner") { options[:quiet] = true }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

def load_yaml(relative_path)
  YAML.safe_load_file(File.join(STORE_ROOT, relative_path), aliases: false) || {}
rescue StandardError
  {}
end

def label_for(identifier)
  identifier.to_s.split("-").map(&:capitalize).join(" ")
end

def overview_payload
  providers = load_yaml("providers/providers.yaml").fetch("providers", {})
  harnesses = load_yaml("integrations/harnesses.yaml").fetch("harnesses", {})
  bundles = load_yaml("integrations/capability-bundles.yaml").fetch("bundles", {})
  servers = load_yaml("integrations/mcp/registry.yaml").fetch("servers", {})
  marketplace = load_yaml("integrations/marketplace-harnesses.yaml").fetch("harnesses", {})

  {
    "app" => {
      "name" => APP_NAME,
      "version" => APP_VERSION,
      "tagline" => "A portable map for every agent, model, and mission.",
      "safety" => "Loopback-only · read-only · no secrets in the browser",
    },
    "generated_at" => Time.now.utc.iso8601,
    "counts" => {
      "harnesses" => harnesses.length,
      "providers" => providers.length,
      "mcp_servers" => servers.length,
      "bundles" => bundles.length,
      "marketplace_harnesses" => marketplace.length,
    },
    "providers" => providers.map do |name, provider|
      {
        "id" => name,
        "name" => label_for(name),
        "env" => provider["env"],
        "endpoint_env" => provider["endpoint_env"],
        "clients" => Array(provider["primary_clients"]),
        "class" => provider["class"] || (name.start_with?("companion-") ? "companion" : "model"),
      }
    end,
    "harnesses" => harnesses.map do |name, harness|
      {
        "id" => name,
        "name" => label_for(name),
        "command" => harness["command"],
        "capabilities" => Array(harness["capabilities"]),
        "smoke" => harness["smoke"],
      }
    end,
    "bundles" => bundles.map do |name, bundle|
      {
        "id" => name,
        "name" => label_for(name),
        "description" => bundle["description"],
        "servers" => Array(bundle["servers"]),
        "high_risk" => bundle["high_risk"] == true,
      }
    end,
    "marketplace" => marketplace.map do |name, contract|
      {
        "id" => name,
        "name" => label_for(name),
        "slug" => contract["marketplace_slug"],
        "repository" => contract["source_repository"],
        "profile" => contract["portable_profile"],
      }
    end,
    "commands" => {
      "setup" => "./bin/agentctl credentials op setup",
      "doctor" => "./bin/agentctl doctor --json",
      "fleet" => "./bin/agentctl fleet smoke --json",
      "marketplace" => "./bin/agentctl marketplace audit --strict",
      "sync" => "./bin/agentctl sync",
    },
  }
end

def safe_detail(value)
  value.to_s
       .gsub(/(Bearer\s+)[A-Za-z0-9._-]{12,}/i, "\\1[redacted]")
       .gsub(/(sk-[A-Za-z0-9_-]{8,})/, "[redacted]")
       .lines.last(20).join[0, 5000]
end

def check_command(kind)
  case kind
  when "doctor"
    [RbConfig.ruby, File.join(STORE_ROOT, "scripts", "doctor.rb"), "--json"]
  when "fleet"
    [RbConfig.ruby, File.join(STORE_ROOT, "scripts", "hub-fleet-smoke.rb"), "--json"]
  when "marketplace"
    [RbConfig.ruby, File.join(STORE_ROOT, "scripts", "marketplace-audit.rb"), "--json"]
  else
    nil
  end
end

def capture_command(command, seconds)
  stdin, stdout, stderr, waiter = Open3.popen3(*command, chdir: STORE_ROOT)
  stdin.close
  output = +""
  error = +""
  output_reader = Thread.new { output << stdout.read }
  error_reader = Thread.new { error << stderr.read }
  timed_out = waiter.join(seconds).nil?
  if timed_out
    Process.kill("TERM", waiter.pid) rescue nil
    waiter.join(2)
    Process.kill("KILL", waiter.pid) rescue nil unless waiter.join(0)
  end
  output_reader.join(2)
  error_reader.join(2)
  [output, error, timed_out ? nil : waiter.value, timed_out]
ensure
  stdin.close rescue nil
  stdout.close rescue nil
  stderr.close rescue nil
end

def run_check(kind)
  command = check_command(kind)
  return { "kind" => kind, "status" => "error", "message" => "Unknown read-only check" } unless command

  output = ""
  error = ""
  status = nil
  begin
    output, error, status, timed_out = capture_command(command, 20)
    if timed_out
      return { "kind" => kind, "status" => "warn", "message" => "Check timed out after 20 seconds" }
    end
  rescue StandardError => exception
    return { "kind" => kind, "status" => "error", "message" => safe_detail(exception.message) }
  end
  if status.nil?
    return { "kind" => kind, "status" => "warn", "message" => "Check timed out after 20 seconds" }
  end

  parsed = JSON.parse(output) rescue nil
  result = {
    "kind" => kind,
    "status" => status&.success? ? "ok" : "error",
    "exit_code" => status&.exitstatus,
  }
  if parsed
    result["data"] = parsed
  else
    result["message"] = safe_detail([output, error].join)
  end
  result
end

def content_type(path)
  {
    ".html" => "text/html; charset=utf-8",
    ".css" => "text/css; charset=utf-8",
    ".js" => "text/javascript; charset=utf-8",
    ".json" => "application/json; charset=utf-8",
    ".png" => "image/png",
    ".svg" => "image/svg+xml",
    ".ico" => "image/x-icon",
    ".md" => "text/markdown; charset=utf-8",
  }.fetch(File.extname(path), "application/octet-stream")
end

def json_response(payload)
  JSON.generate(payload)
end

def route_request(target)
  uri = URI.parse(target)
  case uri.path
  when "/", "/index.html"
    path = File.join(WEB_ROOT, "index.html")
    return [200, content_type(path), File.read(path)]
  when "/api/overview"
    return [200, "application/json; charset=utf-8", json_response(overview_payload)]
  when "/healthz"
    return [200, "application/json; charset=utf-8", json_response({ "ok" => true, "name" => APP_NAME, "version" => APP_VERSION })]
  end

  if uri.path.start_with?("/api/check/")
    kind = uri.path.delete_prefix("/api/check/")
    return [200, "application/json; charset=utf-8", json_response(run_check(kind))]
  end

  if uri.path.start_with?("/docs/")
    relative = uri.path.delete_prefix("/")
    candidate = File.expand_path(relative, STORE_ROOT)
    prefix = "#{File.expand_path(STORE_ROOT)}#{File::SEPARATOR}"
    return [403, "text/plain; charset=utf-8", "Forbidden\n"] unless candidate.start_with?(prefix)
    return [404, "text/plain; charset=utf-8", "Not found\n"] unless File.file?(candidate)

    return [200, content_type(candidate), File.binread(candidate)]
  end

  relative = uri.path.delete_prefix("/")
  candidate = File.expand_path(relative, WEB_ROOT)
  prefix = "#{File.expand_path(WEB_ROOT)}#{File::SEPARATOR}"
  return [403, "text/plain; charset=utf-8", "Forbidden\n"] unless candidate == WEB_ROOT || candidate.start_with?(prefix)
  return [404, "text/plain; charset=utf-8", "Not found\n"] unless File.file?(candidate)

  [200, content_type(candidate), File.binread(candidate)]
rescue URI::InvalidURIError
  [400, "text/plain; charset=utf-8", "Bad request\n"]
rescue StandardError => exception
  [500, "text/plain; charset=utf-8", "Agent Atlas error: #{safe_detail(exception.message)}\n"]
end

def write_response(socket, status_code, type, body, include_body = true)
  reason = {
    200 => "OK",
    400 => "Bad Request",
    403 => "Forbidden",
    404 => "Not Found",
    405 => "Method Not Allowed",
    500 => "Internal Server Error",
  }.fetch(status_code, "Response")
  body = body.to_s.b
  socket.write("HTTP/1.1 #{status_code} #{reason}\r\n")
  socket.write("Content-Type: #{type}\r\n")
  socket.write("Content-Length: #{body.bytesize}\r\n")
  socket.write("Cache-Control: no-store\r\n")
  socket.write("X-Content-Type-Options: nosniff\r\n")
  socket.write("Connection: close\r\n\r\n")
  socket.write(body) if include_body
end

def handle_client(socket)
  request_line = socket.gets
  return unless request_line

  method, target, _http_version = request_line.split(" ", 3)
  while (line = socket.gets)
    break if line == "\r\n" || line == "\n"
  end

  if method != "GET" && method != "HEAD"
    write_response(socket, 405, "text/plain; charset=utf-8", "Agent Atlas is read-only\n")
  else
    response = route_request(target)
    write_response(socket, *response, method == "GET")
  end
rescue StandardError
  # The client may close the connection while the browser is navigating.
ensure
  socket.close rescue nil
end

unless File.file?(File.join(WEB_ROOT, "index.html")) && File.file?(File.join(WEB_ROOT, "styles.css")) && File.file?(File.join(WEB_ROOT, "app.js"))
  warn "Agent Atlas web assets are incomplete under #{WEB_ROOT}"
  exit 1
end

unless options[:allow_remote] || %w[127.0.0.1 localhost ::1].include?(options[:bind])
  warn "Refusing non-loopback bind #{options[:bind]}; pass --allow-remote only on a trusted network"
  exit 1
end

if options[:check]
  puts "Agent Atlas web assets ready: #{WEB_ROOT}"
  exit 0
end

server = TCPServer.new(options[:bind], options[:port])
actual_port = server.addr[1]
url = "http://#{options[:bind]}:#{actual_port}"
unless options[:quiet]
  puts "#{APP_NAME} listening at #{url}"
  puts "Read-only local console; press Ctrl-C to stop."
  STDOUT.flush
end

if options[:open]
  case RUBY_PLATFORM
  when /darwin/
    system("open", url)
  when /linux/
    system("xdg-open", url)
  when /mswin|mingw/
    system("start", url)
  end
end

Thread.report_on_exception = false
trap("INT") { exit 0 }
trap("TERM") { exit 0 }

loop do
  client = server.accept
  Thread.new(client) { |socket| handle_client(socket) }
end
