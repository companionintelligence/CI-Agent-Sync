#!/usr/bin/env ruby
# Create a safe, structure-preserving snapshot of JSON or YAML configuration.

require "json"
require "yaml"

input, output = ARGV
abort "usage: redact-config.rb INPUT OUTPUT" unless input && output

SENSITIVE = /api.?key|token|secret|password|credential|cookie|session.?key|private.?key|authorization|oauth|auth/i

def scrub(value, key = nil)
  if key && key.match?(SENSITIVE)
    return "<redacted>"
  end

  case value
  when Hash
    value.each_with_object({}) { |(k, v), out| out[k] = scrub(v, k.to_s) }
  when Array
    value.map { |v| scrub(v, key) }
  when String
    value.length > 300 ? "<long string #{value.length} chars>" : value
  else
    value
  end
end

raw = File.read(input)
if File.extname(input).downcase == ".json"
  data = JSON.parse(raw)
  File.write(output, JSON.pretty_generate(scrub(data)) + "\n")
else
  data = YAML.safe_load(raw, aliases: true)
  File.write(output, YAML.dump(scrub(data)))
end
