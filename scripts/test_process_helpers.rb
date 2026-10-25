#!/usr/bin/env ruby

require_relative "process_helpers"

large_output, large_error, large_status = AgentConfigProcess.capture_with_timeout(
  [RbConfig.ruby, "-e", "print %q[x] * 200_000"],
  3,
)
abort "large-output capture failed" unless large_status&.success? && large_output.length == 200_000 && large_error.empty?

timed_output, timed_error, timed_status = AgentConfigProcess.capture_with_timeout(
  [RbConfig.ruby, "-e", "sleep 5"],
  0.2,
)
abort "timeout capture failed" unless timed_status.nil? && timed_output.empty? && timed_error.empty?

puts "process helper tests: ok"
