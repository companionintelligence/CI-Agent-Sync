#!/usr/bin/env ruby

require "digest"
require "fileutils"
require "json"
require "open3"
require "optparse"
require "pathname"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
MANIFEST_PATH = File.join(STORE_ROOT, "sync", "manifest.yaml")
DEFAULT_TARGETS_PATH = File.join(STORE_ROOT, "sync", "targets.yaml")

options = {
  apply: false,
  json: false,
  prune: false,
  targets: DEFAULT_TARGETS_PATH,
  explicit_targets: [],
}

OptionParser.new do |parser|
  parser.banner = "Usage: sync.rb [--apply] [--prune] [--target PATH ...] [--targets FILE] [--json]"
  parser.on("--apply", "Apply the reviewed plan") { options[:apply] = true }
  parser.on("--prune", "Apply explicit manifest deletions") { options[:prune] = true }
  parser.on("--target PATH", "Sync one target repository") { |value| options[:explicit_targets] << value }
  parser.on("--targets FILE", "Read machine-local targets from FILE") { |value| options[:targets] = File.expand_path(value) }
  parser.on("--json", "Print machine-readable results") { options[:json] = true }
  parser.on("--help") { puts parser; exit 0 }
end.parse!

abort "--prune requires --apply" if options[:prune] && !options[:apply]

def load_yaml(path)
  YAML.safe_load(File.read(path), aliases: false) || {}
end

def expand_path(value)
  value.to_s
    .gsub("${STORE_ROOT}", STORE_ROOT)
    .gsub("${HOME}", Dir.home)
    .gsub("${CI_ROOT}", ENV.fetch("CI_ROOT", File.join(Dir.home, "devel", "ci")))
end

def relative_safe?(path)
  value = path.to_s
  !value.empty? && !Pathname.new(value).absolute? && !value.split("/").include?("..")
end

def git_status(path)
  output, _error, status = Open3.capture3("git", "-C", path, "status", "--porcelain", "--branch")
  return nil unless status.success?

  lines = output.lines.map(&:chomp)
  branch_line = lines.shift.to_s
  {
    dirty: lines.any? { |line| !line.empty? },
    detached: branch_line.include?("HEAD (no branch)"),
  }
rescue Errno::ENOENT
  nil
end

def sha256(path)
  Digest::SHA256.file(path).hexdigest
end

def target_policy(target_root, target_entry, manifest)
  policy = (target_entry["policy"] || {}).dup
  local_path = File.join(target_root, manifest.dig("policy", "target_policy_file").to_s)
  if File.file?(local_path)
    local = load_yaml(local_path)
    abort "target policy version must be 1: #{local_path}" if local.is_a?(Hash) && local.key?("version") && local["version"] != 1
    policy.merge!(local) if local.is_a?(Hash)
  end
  policy["groups"] ||= manifest.dig("policy", "default_groups") || []
  policy
end

def select_items(manifest, policy)
  selected_groups = Array(policy["groups"])
  excluded = Array(policy["exclude"])
  included = Array(policy["include"])
  overrides = policy["overrides"].is_a?(Hash) ? policy["overrides"] : {}

  manifest.fetch("items").select do |item|
    id = item.fetch("id")
    selected = Array(item["groups"]).any? { |group| selected_groups.include?(group) }
    selected = true if included.include?(id)
    selected = false if excluded.include?(id)
    selected = overrides[id] if overrides.key?(id) && [true, false].include?(overrides[id])
    selected
  end
end

def validate_item!(item)
  %w[id source destination groups].each do |key|
    abort "sync manifest item missing #{key}: #{item.inspect}" unless item.key?(key)
  end
  abort "unsafe source path for #{item["id"]}" unless relative_safe?(item["source"])
  abort "unsafe destination path for #{item["id"]}" unless relative_safe?(item["destination"])
  if item["source"].match?(%r{(^|/)(agents|providers/\.env|\.env|auth|credentials)(/|\.|$)}i)
    abort "native state cannot be synced: #{item["id"]}"
  end
end

manifest = load_yaml(MANIFEST_PATH)
abort "sync manifest version must be 1" unless manifest["version"] == 1
manifest.fetch("items").each { |item| validate_item!(item) }
item_ids = manifest.fetch("items").map { |item| item.fetch("id") }
abort "duplicate sync manifest item id" unless item_ids.uniq.length == item_ids.length

target_entries = if options[:explicit_targets].any?
                   options[:explicit_targets].map do |path|
                     { "name" => File.basename(File.expand_path(path)), "path" => path, "policy" => {} }
                   end
                 elsif File.file?(options[:targets])
                   config = load_yaml(options[:targets])
                   abort "targets file version must be 1" unless config["version"] == 1
                   Array(config["targets"])
                 else
                   []
                 end

if target_entries.empty?
  message = "No targets configured. Copy sync/targets.yaml.example to sync/targets.yaml or pass --target PATH."
  puts(options[:json] ? JSON.generate("targets" => [], "message" => message) : message)
  exit 0
end

results = []
target_entries.each do |entry|
  name = entry.fetch("name") { File.basename(expand_path(entry.fetch("path"))) }
  target_root = File.expand_path(expand_path(entry.fetch("path")))
  result = { "name" => name, "path" => target_root, "status" => "planned", "changes" => [], "skipped" => [] }

  unless Dir.exist?(target_root)
    result["status"] = "missing"
    result["skipped"] << "target directory does not exist"
    results << result
    next
  end

  git = git_status(target_root)
  if git.nil?
    result["status"] = "not-git"
    result["skipped"] << "target is not a Git checkout"
    results << result
    next
  end
  if git[:dirty]
    result["status"] = "skipped-dirty"
    result["skipped"] << "target has uncommitted changes"
    results << result
    next
  end
  if git[:detached]
    result["status"] = "skipped-detached"
    result["skipped"] << "target is detached"
    results << result
    next
  end

  policy = target_policy(target_root, entry, manifest)
  if policy["enabled"] == false
    result["status"] = "disabled"
    results << result
    next
  end

  select_items(manifest, policy).each do |item|
    source = File.join(STORE_ROOT, item.fetch("source"))
    destination = File.join(target_root, item.fetch("destination"))
    unless File.file?(source)
      result["status"] = "invalid"
      result["skipped"] << "missing source: #{item["source"]}"
      next
    end
    next if File.file?(destination) && sha256(source) == sha256(destination)

    result["changes"] << {
      "id" => item["id"],
      "version" => item.fetch("version", 1),
      "source" => item["source"],
      "destination" => item["destination"],
      "action" => File.file?(destination) ? "update" : "add",
    }
    next unless options[:apply]

    FileUtils.mkdir_p(File.dirname(destination))
    FileUtils.cp(source, destination)
  end

  if options[:prune]
    Array(manifest["deletions"]).each do |deletion|
      destination = deletion.fetch("destination")
      abort "unsafe deletion path: #{destination}" unless relative_safe?(destination)
      target = File.join(target_root, destination)
      next unless File.exist?(target)

      result["changes"] << {
        "id" => "deletion/#{destination}",
        "action" => "delete",
        "destination" => destination,
        "reason" => deletion["reason"],
      }
      FileUtils.rm_rf(target) if options[:apply]
    end
  end

  result["status"] = "applied" if options[:apply] && result["changes"].any?
  results << result
end

unless options[:json]
  puts(options[:apply] ? "Applied reviewed agent-config sync" : "Agent-config sync plan (dry run)")
  results.each do |result|
    puts "  #{result["name"]} — #{result["status"]} — #{result["path"]}"
    result["changes"].each do |change|
      puts "    #{change["action"]}: #{change["destination"]} (#{change["id"]})"
    end
    result["skipped"].each { |reason| puts "    note: #{reason}" }
  end
else
  puts JSON.pretty_generate("apply" => options[:apply], "prune" => options[:prune], "targets" => results)
end

exit 1 if results.any? { |result| %w[invalid missing not-git].include?(result["status"]) }
