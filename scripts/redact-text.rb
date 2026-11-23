#!/usr/bin/env ruby

input, output = ARGV
abort "usage: redact-text.rb INPUT OUTPUT" unless input && output

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


pattern = /((?:api[_-]?key|token|secret|password|credential|authorization|cookie|session[_-]?key|private[_-]?key|oauth|auth)[[:space:]]*[:=][[:space:]]*)([^,;[:space:]}]+|"[^"]*"|'[^']*')/i
lines = File.readlines(input, chomp: true).map do |line|
  anonymize(line.gsub(pattern) { "#{$1}<redacted>" })
end
File.write(output, lines.join("\n") + "\n")
