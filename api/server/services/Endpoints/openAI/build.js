const { removeNullishValues } = require('librechat-data-provider');
const generateArtifactsPrompt = require('~/app/clients/prompts/artifacts');
const { atomicIdeasJsonSchema } = require('~/app/clients/prompts');

const buildOptions = (endpoint, parsedBody) => {
  const {
    modelLabel,
    chatGptLabel,
    promptPrefix,
    maxContextTokens,
    resendFiles = true,
    imageDetail,
    iconURL,
    greeting,
    spec,
    artifacts,
    ...modelOptions
  } = parsedBody;

  // Use Structured Outputs (json_schema) instead of json_object
  // This provides better validation and doesn't require "json" in messages
  if (modelOptions.model && modelOptions.model.includes('gpt')) {
    modelOptions.response_format = atomicIdeasJsonSchema;
  }

  const endpointOption = removeNullishValues({
    endpoint,
    modelLabel,
    chatGptLabel,
    promptPrefix,
    resendFiles,
    imageDetail,
    iconURL,
    greeting,
    spec,
    maxContextTokens,
    modelOptions,
  });

  if (typeof artifacts === 'string') {
    endpointOption.artifactsPrompt = generateArtifactsPrompt({ endpoint, artifacts });
  }

  return endpointOption;
};

module.exports = buildOptions;
