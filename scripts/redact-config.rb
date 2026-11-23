#!/usr/bin/env ruby
# Create a safe, structure-preserving snapshot of JSON or YAML configuration.

require "json"
require "yaml"

input, output = ARGV
abort "usage: redact-config.rb INPUT OUTPUT" unless input && output

# Snapshots are regenerated from this machine's own configs, so the home directory, mail
# accounts and the tailnet suffix are kept out of them whatever the config holds.
HOME_DIR = Dir.home
HOME_PLACEHOLDER = HOME_DIR.start_with?("/Users/") ? "/Users/<user>" : "<home>"
MAIL_ACCOUNT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

def anonymize(text)
  out = text.gsub(HOME_DIR, HOME_PLACEHOLDER).gsub(MAIL_ACCOUNT, "<account-email>")
  suffix = ENV.fetch("CI_TAILNET_DNS_SUFFIX", "")
  suffix.empty? ? out : out.gsub(suffix, "<tailnet>")
end


# Match credential-bearing keys without treating ordinary metadata such as
# `trackTokenUsage` or `contextCompactingThreshold.tokens` as secrets.
SENSITIVE = /api[._-]?key|(?:access|refresh|auth|gateway|remote)?[._-]?token\z|(?:^|[._-])token(?:$|[._-])|[a-z]token\z|secret|password|credential|cookie|session[._-]?key|private[._-]?key|authorization|oauth|auth\z|\Auser[._-]?id\z/i

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
  File.write(output, anonymize(JSON.pretty_generate(scrub(data))) + "\n")
else
  data = YAML.safe_load(raw, aliases: true)
  File.write(output, anonymize(YAML.dump(scrub(data))))
end
