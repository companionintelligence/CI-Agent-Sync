#!/usr/bin/env ruby

require "json"
require "net/http"
require "open3"
require "socket"
require "timeout"
require "uri"

ROOT = File.expand_path("..", __dir__)
node = ENV.fetch("NODE_BINARY", "node")
command = [node, "--experimental-strip-types", "--no-warnings", File.join(ROOT, "src", "cli.ts"), "atlas", "--bind", "127.0.0.1", "--port", "0"]
reader, writer = IO.pipe
pid = Process.spawn(*command, out: writer, err: writer)
writer.close

begin
  line = Timeout.timeout(5) { reader.gets }
  match = line.to_s.match(%r{http://127\.0\.0\.1:(\d+)})
  abort "TypeScript server did not start: #{line.inspect}" unless match
  port = match[1].to_i
  base = "http://127.0.0.1:#{port}"
  response = Net::HTTP.get_response(URI("#{base}/api/overview"))
  abort "overview request failed: #{response.code}" unless response.code == "200"
  payload = JSON.parse(response.body)
  abort "wrong product name" unless payload.dig("app", "name") == "CI Agent Sync"
  abort "overview omitted harnesses" unless payload.dig("counts", "harnesses").to_i.positive?
  abort "overview omitted profiles" unless payload.fetch("profiles").any? { |profile| profile["id"] == "ceo" }
  token_response = Net::HTTP.get_response(URI("#{base}/assets/ci-common/tokens.css"))
  abort "CI-Common token route failed" unless token_response.code == "200" && token_response.body.include?("--background")
  post_request = Net::HTTP::Post.new("/api/action/backup")
  post_request["Content-Type"] = "application/json"
  post_request.body = "{}"
  post_response = Net::HTTP.start("127.0.0.1", port) { |http| http.request(post_request) }
  post_payload = JSON.parse(post_response.body)
  abort "backup confirmation guard failed" unless post_response.code == "400" && post_payload["message"].include?("confirmation")
  docs_response = Net::HTTP.get_response(URI("#{base}/docs/portable-setup.md"))
  abort "docs route failed: #{docs_response.code}" unless docs_response.code == "200" && docs_response.body.include?("Portable setup")
  head_request = Net::HTTP::Head.new("/")
  head_response = Net::HTTP.start("127.0.0.1", port) { |http| http.request(head_request) }
  abort "HEAD route failed: #{head_response.code}" unless head_response.code == "200" && head_response.body.to_s.empty?
ensure
  reader.close rescue nil
  Process.kill("TERM", pid) rescue nil
  Process.wait(pid) rescue nil
end

puts "CI Agent Sync TypeScript web fixture: ok"
