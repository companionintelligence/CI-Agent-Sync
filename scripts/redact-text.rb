#!/usr/bin/env ruby

input, output = ARGV
abort "usage: redact-text.rb INPUT OUTPUT" unless input && output

pattern = /((?:api[_-]?key|token|secret|password|credential|authorization|cookie|session[_-]?key|private[_-]?key|oauth|auth)[[:space:]]*[:=][[:space:]]*)([^,;[:space:]}]+|"[^"]*"|'[^']*')/i
lines = File.readlines(input, chomp: true).map do |line|
  line.gsub(pattern) { "#{$1}<redacted>" }
end
File.write(output, lines.join("\n") + "\n")
