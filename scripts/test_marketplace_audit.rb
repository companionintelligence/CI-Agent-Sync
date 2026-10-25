#!/usr/bin/env ruby

require "fileutils"
require "json"
require "open3"
require "rbconfig"
require "tmpdir"

ROOT = File.expand_path("..", __dir__)
SCRIPT = File.join(ROOT, "scripts", "marketplace-audit.rb")

def write_json(path, value)
  FileUtils.mkdir_p(File.dirname(path))
  File.write(path, JSON.pretty_generate(value) + "\n")
end

def env_entries(names)
  names.map { |key| { "key" => key, "value" => "test" } }
end

def app_config(slug, version, inference, wake = {})
  {
    "id" => slug,
    "version" => version,
    "hub_integration" => {
      "mcp_client" => true,
      **wake,
      "memory" => { "url_env" => "CI_SERVER_URL", "token_env" => "CI_SERVER_TOKEN" },
      "inference" => inference,
    },
  }
end

def app_compose(slug, version, image_digest, env)
  {
    "services" => [
      {
        "name" => slug,
        "image" => "ghcr.io/companionintelligence/#{slug}:#{version}@sha256:#{image_digest}",
        "environment" => env_entries(env),
      },
    ],
  }
end

Dir.mktmpdir("marketplace-audit") do |root|
  apps = File.join(root, "apps")
  write_json(
    File.join(apps, "ci-hermes", "config.json"),
    app_config(
      "ci-hermes",
      "v2026.10.2",
      {
        "llm_base_url" => "HERMES_OPENAI_BASE_URL",
        "llm_api_key" => "HERMES_OPENAI_API_KEY",
        "chat_model" => "HERMES_DEFAULT_MODEL",
        "embedding_model" => "HERMES_EMBEDDINGS_MODEL",
        "ollama_host" => "OLLAMA_HOST",
        "num_ctx" => "HERMES_NUM_CTX",
      },
    ),
  )
  write_json(
    File.join(apps, "ci-hermes", "docker-compose.json"),
    app_compose("ci-hermes", "v2026.10.2", "a" * 64, %w[APP_SEED CI_HUB_URL CI_SERVER_URL CI_SERVER_TOKEN]),
  )

  write_json(
    File.join(apps, "ci-openclaw", "config.json"),
    app_config(
      "ci-openclaw",
      "2026.10.13",
      {
        "llm_base_url" => "OPENAI_API_BASE",
        "llm_api_key" => "OPENAI_API_KEY",
        "chat_model" => "DEFAULT_MODEL",
        "embedding_model" => "EMBEDDINGS_MODEL",
        "ollama_host" => "OLLAMA_HOST",
        "num_ctx" => "CI_LLM_NUM_CTX",
      },
      { "wake_endpoint" => "/hooks/wake", "wake_port" => 18789 },
    ),
  )
  write_json(
    File.join(apps, "ci-openclaw", "docker-compose.json"),
    app_compose("ci-openclaw", "2026.10.13", "b" * 64, %w[APP_SEED CI_HUB_URL CI_SERVER_URL CI_SERVER_TOKEN]),
  )

  output, error, status = Open3.capture3(
    RbConfig.ruby, SCRIPT, "--marketplace", root, "--json"
  )
  abort "passing fixture failed: #{error}\n#{output}" unless status.success?
  result = JSON.parse(output)
  abort "passing fixture reported errors" unless result.dig("summary", "error").to_i.zero?

  broken = File.join(apps, "ci-openclaw", "docker-compose.json")
  compose = JSON.parse(File.read(broken))
  compose["services"][0]["image"] = "ghcr.io/companionintelligence/ci-openclaw:2026.9.1@sha256:#{"c" * 64}"
  write_json(broken, compose)

  output, _error, status = Open3.capture3(
    RbConfig.ruby, SCRIPT, "--marketplace", root, "--json"
  )
  abort "broken fixture unexpectedly passed" if status.success?
  result = JSON.parse(output)
  abort "broken fixture did not report release drift" unless result.fetch("checks").any? { |check| check["id"] == "marketplace.openclaw.compose.release" && check["status"] == "error" }
end

puts "marketplace audit tests passed"
