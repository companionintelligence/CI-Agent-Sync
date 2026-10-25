#!/usr/bin/env ruby

# Read-only view of the portable operator profiles. This is deliberately a
# policy renderer, not a client configurator: it never reads native app state,
# OAuth databases, or credential values.

require "json"
require "optparse"
require "yaml"

STORE_ROOT = File.expand_path("..", __dir__)
CONTRACT_PATH = File.join(STORE_ROOT, "integrations", "operator-contract.yaml")
PACKS_PATH = File.join(STORE_ROOT, "integrations", "workflow-packs.yaml")
BUNDLES_PATH = File.join(STORE_ROOT, "integrations", "capability-bundles.yaml")

options = { json: false }
parser = OptionParser.new do |p|
  p.banner = "Usage: profile.rb list|show NAME [--json]"
  p.on("--json", "emit machine-readable policy") { options[:json] = true }
  p.on("--help") { puts p; exit 0 }
end
command = ARGV.shift || "list"
parser.parse!(ARGV)

def load_yaml(path)
  YAML.safe_load(File.read(path), aliases: false) || {}
end

contract = load_yaml(CONTRACT_PATH)
packs = load_yaml(PACKS_PATH)
bundles = load_yaml(BUNDLES_PATH)
profiles = contract.fetch("profiles", {})

fail_with = lambda do |message|
  warn message
  exit 2
end

case command
when "list"
  payload = {
    "schema_version" => 1,
    "profiles" => profiles.keys.sort,
    "workflow_packs" => packs.fetch("packs", {}).keys.sort,
  }
  if options[:json]
    puts JSON.pretty_generate(payload)
  else
    puts "Profiles: #{payload.fetch('profiles').join(', ')}"
    puts "Workflow packs: #{payload.fetch('workflow_packs').join(', ')}"
  end
when "show"
  name = ARGV.shift.to_s
  fail_with.call("profile name is required") if name.empty?
  profile = profiles[name]
  fail_with.call("unknown profile #{name.inspect}; choose #{profiles.keys.sort.join(', ')}") unless profile
  referenced_bundles = Array(profile["bundles"]).each_with_object({}) do |bundle_name, result|
    result[bundle_name] = bundles.fetch("bundles", {})[bundle_name]
  end
  referenced_workflows = Array(profile["workflows"]).each_with_object({}) do |workflow_name, result|
    document = File.join(STORE_ROOT, "workflows", "#{workflow_name}.md")
    result[workflow_name] = if File.file?(document)
                              { "type" => "document", "path" => "workflows/#{workflow_name}.md" }
                            else
                              packs.fetch("packs", {})[workflow_name]
                            end
  end
  payload = {
    "schema_version" => 1,
    "profile" => name,
    "policy" => profile,
    "bundles" => referenced_bundles,
    "workflows" => referenced_workflows,
    "credential_values_included" => false,
  }
  if options[:json]
    puts JSON.pretty_generate(payload)
  else
    puts "Profile: #{name}"
    puts "Bundles: #{Array(profile['bundles']).join(', ')}"
    puts "Workflows: #{Array(profile['workflows']).join(', ')}"
    puts "Default chain: #{profile['default_chain']}"
    puts "Mutation policy: #{profile['mutation_policy']}"
  end
else
  fail_with.call("supported profile commands: list, show NAME")
end
