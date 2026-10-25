#!/usr/bin/env ruby

# Repair only schema drift and references to an unavailable optional plugin.
# This intentionally does not copy or print the native config because it can
# contain credentials. The write is atomic and only happens after JSON parses.

require "json"
require "fileutils"

path = File.expand_path(ENV.fetch("OPENCLAW_CONFIG", File.join(Dir.home, ".openclaw", "openclaw.json")))
abort "OpenClaw config not found: #{path}" unless File.file?(path)

data = JSON.parse(File.read(path))
removed = []

[
  [data.dig("agents"), "defaults", "mediaModels"],
  [data.dig("agents", "defaults"), "modelPolicy"],
  [data.dig("agents"), "entries"],
  [data.dig("auth", "profiles"), "github-copilot:github"],
  [data.dig("plugins", "entries"), "github-copilot"],
  [data.dig("plugins", "entries"), "google"],
  [data.dig("meta"), "migrations"],
].each do |parent, *keys|
  next unless parent.is_a?(Hash)
  cursor = parent
  keys[0...-1].each do |key|
    cursor = cursor[key]
    break unless cursor.is_a?(Hash)
  end
  key = keys.last
  next unless cursor.is_a?(Hash) && cursor.key?(key)
  cursor.delete(key)
  removed << ([*keys].join("."))
end

if data.dig("plugins", "allow").is_a?(Array)
  before = data["plugins"]["allow"].length
  unavailable_plugins = %w[github-copilot google]
  data["plugins"]["allow"] = data["plugins"]["allow"].reject { |name| unavailable_plugins.include?(name) }
  removed << "plugins.allow.unavailable" if data["plugins"]["allow"].length != before
end

if data.dig("agents", "defaults", "models").is_a?(Hash)
  legacy_models = data["agents"]["defaults"].delete("models")
  policy = data["agents"]["defaults"]["modelPolicy"] ||= {}
  policy["allow"] = (Array(policy["allow"]) + legacy_models.keys).uniq
  removed << "agents.defaults.models.legacy"
end

if data.dig("agents", "defaults", "model", "fallbacks").is_a?(Array)
  before = data["agents"]["defaults"]["model"]["fallbacks"]
  data["agents"]["defaults"]["model"]["fallbacks"] = before.reject { |model| model.to_s.start_with?("github-copilot/") }
  removed << "agents.defaults.model.fallbacks.github-copilot" if before != data["agents"]["defaults"]["model"]["fallbacks"]
  data["agents"]["defaults"]["model"].delete("fallbacks") if data["agents"]["defaults"]["model"]["fallbacks"].empty?
end

if data.dig("models", "providers", "google").is_a?(Hash) && Array(data.dig("models", "providers", "google", "models")).empty?
  data["models"]["providers"].delete("google")
  removed << "models.providers.google.empty"
end

if data.dig("skills", "entries").is_a?(Hash)
  data["skills"]["entries"].each do |skill, entry|
    next unless entry.is_a?(Hash) && entry.key?("apiKey")
    entry.delete("apiKey")
    removed << "skills.entries.#{skill}.apiKey"
  end
end

temporary = "#{path}.agentctl-tmp-#{Process.pid}"
File.open(temporary, "w", File.stat(path).mode & 0o777) { |file| file.write(JSON.pretty_generate(data) + "\n") }
File.rename(temporary, path)
puts "Repaired OpenClaw schema drift: #{removed.empty? ? "no changes needed" : removed.join(", ")}"
