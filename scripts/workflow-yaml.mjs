/**
 * Neutral structural YAML text helpers shared by release and foundation
 * workflow validators. This module does not encode workflow policy.
 */

import { escapeRegExp } from "./regex.mjs";

/**
 * @param {string} content
 * @param {RegExp} pattern
 * @returns {boolean}
 */
export function workflowHasLine(content, pattern) {
  return content.split(/\r?\n/).some((line) => pattern.test(line));
}

/**
 * @param {string} content
 * @param {string} token
 * @returns {boolean}
 */
export function workflowRunStepIncludes(content, token) {
  return workflowHasLine(
    content,
    new RegExp(`^\\s*(?:-\\s*)?run:\\s*${escapeRegExp(token)}\\s*$`)
  );
}

/**
 * @param {string} content
 * @param {string} jobName
 * @returns {string}
 */
export function workflowJobContent(content, jobName) {
  const lines = content.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) {
    return "";
  }

  const jobPattern = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`);
  const jobIndex = lines.findIndex(
    (line, index) => index > jobsIndex && jobPattern.test(line)
  );
  if (jobIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = jobIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || /^  [A-Za-z0-9_-]+:\s*$/.test(line)) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(jobIndex, endIndex).join("\n");
}

/**
 * @param {string} content
 * @param {string} blockName
 * @param {number} indentation
 * @returns {string}
 */
export function workflowMappingBlockContent(content, blockName, indentation) {
  const lines = content.split(/\r?\n/);
  const prefix = " ".repeat(indentation);
  const blockPattern = new RegExp(
    `^${escapeRegExp(prefix)}${escapeRegExp(blockName)}:\\s*(?:#.*)?$`
  );
  const blockIndex = lines.findIndex((line) => blockPattern.test(line));
  if (blockIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = blockIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    if (
      line.trim() !== "" &&
      line.length - line.trimStart().length <= indentation
    ) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(blockIndex, endIndex).join("\n");
}

/**
 * @param {string} jobContent
 * @param {string} stepName
 * @returns {string}
 */
export function workflowNamedStepContent(jobContent, stepName) {
  const lines = jobContent.split(/\r?\n/);
  const stepPattern = new RegExp(
    `^      - name:\\s*${escapeRegExp(stepName)}\\s*$`
  );
  const stepIndex = lines.findIndex((line) => stepPattern.test(line));
  if (stepIndex === -1) {
    return "";
  }

  let endIndex = lines.length;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    if (/^      - /.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(stepIndex, endIndex).join("\n");
}

/**
 * @param {string} content
 * @param {string} blockName
 * @param {string} scalarName
 * @param {string} value
 */
export function yamlTopLevelBlockHasScalar(
  content,
  blockName,
  scalarName,
  value
) {
  const lines = content.split(/\r?\n/);
  const startPattern = new RegExp(`^${escapeRegExp(blockName)}:\\s*(?:#.*)?$`);
  const nextTopLevelPattern = /^[A-Za-z0-9_-]+:\s*/;
  const scalarPattern = new RegExp(
    `^\\s*(?:-\\s*)?${escapeRegExp(scalarName)}:\\s*${escapeRegExp(value)}\\s*(?:#.*)?$`
  );
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (startPattern.test(lines[index])) {
      startIndex = index;
      break;
    }
  }

  if (startIndex === -1) {
    return false;
  }

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (nextTopLevelPattern.test(line)) {
      break;
    }
    if (scalarPattern.test(line)) {
      return true;
    }
  }

  return false;
}
