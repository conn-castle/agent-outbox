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
 * Collapse a workflow `run:` block to comparable executable lines: trim
 * whitespace and drop comments/blank lines.
 *
 * @param {string | null | undefined} command
 * @returns {string | null}
 */
export function normalizeRunCommand(command) {
  if (command == null) {
    return null;
  }
  const normalized = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  return normalized.length > 0 ? normalized : null;
}

/**
 * Split a GitHub Actions job body into raw step line blocks.
 *
 * @param {string} jobContent
 * @returns {string[][]}
 */
export function workflowStepBlocks(jobContent) {
  const lines = jobContent.split(/\r?\n/);
  /** @type {string[][]} */
  const blocks = [];
  /** @type {string[] | null} */
  let current = null;
  for (const line of lines) {
    if (/^      - /.test(line)) {
      if (current) {
        blocks.push(current);
      }
      current = [line];
      continue;
    }
    if (current) {
      current.push(line);
    }
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}

/**
 * @typedef {{
 *   stepName: string,
 *   command: string | null,
 *   condition: string | null
 * }} WorkflowStepTuple
 */

/**
 * Parse a named step's name, normalized run command, and `if:` condition.
 *
 * @param {string[]} lines
 * @returns {WorkflowStepTuple}
 */
export function parseWorkflowStepTuple(lines) {
  let stepName = null;
  let condition = null;
  let command = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nameMatch = /^(?:      - name:|        name:)\s*(.+)\s*$/.exec(line);
    if (nameMatch) {
      stepName = nameMatch[1].trim();
      continue;
    }
    const ifMatch = /^        if:\s*(.+)\s*$/.exec(line);
    if (ifMatch) {
      condition = ifMatch[1].trim();
      continue;
    }
    const runMatch = /^        run:\s*(.*)$/.exec(line);
    if (!runMatch) {
      continue;
    }
    const rest = runMatch[1].trim();
    if (
      rest === "|" ||
      rest === "|-" ||
      rest === ">" ||
      rest === ">-" ||
      rest === ""
    ) {
      /** @type {string[]} */
      const body = [];
      for (
        let bodyIndex = index + 1;
        bodyIndex < lines.length;
        bodyIndex += 1
      ) {
        const bodyLine = lines[bodyIndex];
        if (/^        [A-Za-z]/.test(bodyLine)) {
          break;
        }
        if (bodyLine.trim() === "") {
          continue;
        }
        body.push(bodyLine.replace(/^          /, ""));
      }
      command = normalizeRunCommand(body.join("\n"));
    } else {
      command = normalizeRunCommand(rest);
    }
  }
  return { stepName: stepName ?? "", command, condition };
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
