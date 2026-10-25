#!/usr/bin/env ruby

require "json"
require "socket"
require "open3"

root = File.expand_path("..", __dir__)
server = TCPServer.new("127.0.0.1", 0)
port = server.addr[1]
thread = Thread.new do
  loop do
    socket = server.accept
    request = socket.readpartial(16_384) rescue ""
    path = request.lines.first.to_s.split[1].to_s
    body = case path
           when "/api/health"
             JSON.generate(status: "ok")
           when "/api/health/detailed"
             JSON.generate(status: "ok", ok: true, dependencies: [])
           else
             JSON.generate(status: "ok")
           end
    response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: #{body.bytesize}\r\nConnection: close\r\n\r\n#{body}"
    socket.write(response)
    socket.close
  rescue IOError, Errno::EBADF
    break
  end
end

command = [RbConfig.ruby, File.join(root, "scripts", "memory-control-room.rb"), "--json", "--no-mcp", "--base-url", "http://127.0.0.1:#{port}"]
output, error, status = Open3.capture3({ "AGENT_CONFIGS_SECRET_BACKEND" => "native" }, *command)
server.close
thread.kill
abort "memory control-room fixture failed: #{error}" unless status.success?

payload = JSON.parse(output)
raise "unexpected schema" unless payload["schema_version"] == 1
raise "health did not pass" unless payload.dig("summary", "ok").to_i >= 2
raise "fixture had errors" unless payload.dig("summary", "error").to_i.zero?

puts "memory control-room fixture: ok"
