#!/usr/bin/env ruby

require "json"
require "net/http"
require "open3"
require "rbconfig"
require "socket"
require "timeout"
require "uri"

ROOT = File.expand_path("..", __dir__)
SERVER = File.join(ROOT, "scripts", "atlas-web.rb")

abort "missing web assets" unless %w[index.html styles.css app.js].all? { |name| File.file?(File.join(ROOT, "web", name)) }
abort "logo missing" unless File.file?(File.join(ROOT, "web", "assets", "agent-atlas-logo.png"))

output, error, status = Open3.capture3(RbConfig.ruby, SERVER, "--check")
abort "asset check failed: #{error}\n#{output}" unless status.success?

reader, writer = IO.pipe
pid = Process.spawn(RbConfig.ruby, SERVER, "--bind", "127.0.0.1", "--port", "0", out: writer, err: writer)
writer.close

begin
  line = Timeout.timeout(5) { reader.gets }
  match = line.to_s.match(%r{http://127\.0\.0\.1:(\d+)})
  abort "server did not start: #{line.inspect}" unless match
  port = match[1].to_i
  uri = URI("http://127.0.0.1:#{port}/api/overview")
  response = Net::HTTP.get_response(uri)
  abort "overview request failed: #{response.code}" unless response.code == "200"
  payload = JSON.parse(response.body)
  abort "wrong product name" unless payload.dig("app", "name") == "Agent Atlas"
  abort "overview omitted harnesses" unless payload.dig("counts", "harnesses").to_i.positive?
  abort "overview omitted profiles" unless payload.fetch("profiles").any? { |profile| profile["id"] == "ceo" }
  backup_plan = Net::HTTP.get_response(URI("http://127.0.0.1:#{port}/api/check/backup-plan"))
  abort "backup plan failed: #{backup_plan.code}" unless backup_plan.code == "200" && backup_plan.body.include?("Backup plan")
  post_request = Net::HTTP::Post.new("/api/action/backup")
  post_request["Content-Type"] = "application/json"
  post_request.body = "{}"
  post_response = Net::HTTP.start("127.0.0.1", port) { |http| http.request(post_request) }
  post_payload = JSON.parse(post_response.body)
  abort "backup confirmation guard failed" unless post_response.code == "400" && post_payload["message"].include?("confirmation")
  docs_response = Net::HTTP.get_response(URI("http://127.0.0.1:#{port}/docs/portable-setup.md"))
  abort "docs route failed: #{docs_response.code}" unless docs_response.code == "200" && docs_response.body.include?("Portable setup")
  head_request = Net::HTTP::Head.new("/")
  head_response = Net::HTTP.start("127.0.0.1", port) { |http| http.request(head_request) }
  abort "HEAD route failed: #{head_response.code}" unless head_response.code == "200" && head_response.body.to_s.empty?
ensure
  reader.close rescue nil
  Process.kill("TERM", pid) rescue nil
  Process.wait(pid) rescue nil
end

puts "Agent Atlas asset checks passed"
