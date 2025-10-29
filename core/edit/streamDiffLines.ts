import {
  ChatMessage,
  DiffLine,
  ILLM,
  Prediction,
  RuleWithSource,
  StreamDiffLinesPayload,
  ToolResultChatMessage,
  UserChatMessage,
} from "../";
import {
  filterCodeBlockLines,
  filterEnglishLinesAtEnd,
  filterEnglishLinesAtStart,
  filterLeadingAndTrailingNewLineInsertion,
  removeTrailingWhitespace,
  skipLines,
  stopAtLines,
} from "../autocomplete/filtering/streamTransforms/lineStream";
import { streamDiff } from "../diff/streamDiff";
import { filterCodeContent, streamLines } from "../diff/util";
import { getSystemMessageWithRules } from "../llm/rules/getSystemMessageWithRules";
import { gptEditPrompt } from "../llm/templates/edit";
import { defaultApplyPrompt } from "../llm/templates/edit/gpt";
import { findLast } from "../util/findLast";
import { Telemetry } from "../util/posthog";
import { recursiveStream } from "./recursiveStream";
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function constructEditPrompt(
  prefix: string,
  highlighted: string,
  suffix: string,
  llm: ILLM,
  userInput: string,
  language: string | undefined,
): string | ChatMessage[] {
  const template = llm.promptTemplates?.edit ?? gptEditPrompt;
  return llm.renderPromptTemplate(template, [], {
    userInput,
    prefix,
    codeToEdit: highlighted,
    suffix,
    language: language ?? "",
  });
}

function constructApplyPrompt(
  originalCode: string,
  newCode: string,
  llm: ILLM,
) {
  const template = llm.promptTemplates?.apply ?? defaultApplyPrompt;
  const rendered = llm.renderPromptTemplate(template, [], {
    original_code: originalCode,
    new_code: newCode,
  });
  console.log("in constructApplyPrompt: Apply prompt template:", template);
  console.log("in constructApplyPrompt: Rendered apply prompt:", rendered);

  return rendered;
}

export async function* addIndentation(
  diffLineGenerator: AsyncGenerator<DiffLine>,
  indentation: string,
): AsyncGenerator<DiffLine> {
  for await (const diffLine of diffLineGenerator) {
    yield {
      ...diffLine,
      line: indentation + diffLine.line,
    };
  }
}

function modelIsInept(model: string): boolean {
  return !(model.includes("gpt") || model.includes("claude"));
}

export async function* streamDiffLines( // called by the edit mode
  options: StreamDiffLinesPayload,
  llm: ILLM,
  abortController: AbortController,
  overridePrompt: ChatMessage[] | undefined,
  rulesToInclude: RuleWithSource[] | undefined,
): AsyncGenerator<DiffLine> {
  const { type, prefix, highlighted, suffix, input, language } = options;
  console.log("in streamDiffLines, options:", options);
  console.log("in streamDiffLines, overridePrompt:", overridePrompt);

  void Telemetry.capture(
    "inlineEdit",
    {
      model: llm.model,
      provider: llm.providerName,
    },
    true,
  );

  // Strip common indentation for the LLM, then add back after generation
  let oldLines =
    highlighted.length > 0
      ? highlighted.split("\n")
      : // When highlighted is empty, we need to combine last line of prefix and first line of suffix to determine the line being edited
        [(prefix + suffix).split("\n")[prefix.split("\n").length - 1]];

  // But if that line is empty, we can assume we are insertion-only
  if (oldLines.length === 1 && oldLines[0].trim() === "") {
    oldLines = [];
  }

  // Defaults to creating an edit prompt
  // For apply can be overridden with simply apply prompt
  let prompt =
    overridePrompt ??
    (type === "apply"
      ? constructApplyPrompt(oldLines.join("\n"), options.newCode, llm)
      : constructEditPrompt(prefix, highlighted, suffix, llm, input, language));

  console.log("in streamDiffLines, apply/edit prompt", prompt);

  // Rules can be included with edit prompt
  // If any rules are present this will result in using chat instead of legacy completion
  const systemMessage =
    rulesToInclude || llm.baseChatSystemMessage
      ? getSystemMessageWithRules({
          availableRules: rulesToInclude ?? [],
          userMessage:
            typeof prompt === "string"
              ? ({
                  role: "user",
                  content: prompt,
                } as UserChatMessage)
              : (findLast(
                  prompt,
                  (msg) => msg.role === "user" || msg.role === "tool",
                ) as UserChatMessage | ToolResultChatMessage | undefined),
          baseSystemMessage: llm.baseChatSystemMessage,
          contextItems: [],
        }).systemMessage
      : undefined;

  console.log("in streamDiffLines, system message", systemMessage);

  if (systemMessage) {
    if (typeof prompt === "string") {
      prompt = [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: prompt,
        },
      ];
    } else {
      const curSysMsg = prompt.find((msg) => msg.role === "system");
      if (curSysMsg) {
        curSysMsg.content = systemMessage + "\n\n" + curSysMsg.content;
      } else {
        prompt.unshift({
          role: "system",
          content: systemMessage,
        });
      }
    }
  }

  const inept = modelIsInept(llm.model);

  const prediction: Prediction = {
    type: "content",
    content: highlighted,
  };

  console.log("in streamDiffLines, final prompt", prompt);
  if (typeof prompt !== "string") {
    console.log("in streamDiffLines, final prompt[0]:", prompt[0].content);
    console.log("in streamDiffLines, final prompt[1]:", prompt[1].content);
  }

  const completion = recursiveStream(
    llm,
    abortController,
    type,
    prompt,
    prediction,
  );
  let lines = streamLines(completion, true);
  // console.log("start sleeping");
  // await sleep(2000);
  // console.log("done sleeping");

  if (type === "apply") {
    lines = filterCodeContent(lines, true);
  } else {
    lines = filterEnglishLinesAtStart(lines);
    lines = filterCodeBlockLines(lines);
    lines = stopAtLines(lines, () => {});
    lines = skipLines(lines);
    lines = removeTrailingWhitespace(lines);
    if (inept) {
      // lines = fixCodeLlamaFirstLineIndentation(lines);
      lines = filterEnglishLinesAtEnd(lines);
    }
  }

  // lines = filterEnglishLinesAtStart(lines);
  // lines = filterCodeBlockLines(lines);
  // lines = stopAtLines(lines, () => {});
  // lines = skipLines(lines);
  // lines = removeTrailingWhitespace(lines);
  // if (inept) {
  //   // lines = fixCodeLlamaFirstLineIndentation(lines);
  //   lines = filterEnglishLinesAtEnd(lines);
  // }

  // console.log("-------------Filtered Lines-----------------")
  // for await (const line of lines) {
  //   console.log(line);
  // }
  // console.log("-------------Filtered Lines-----------------")

  let diffLines = streamDiff(oldLines, lines);
  diffLines = filterLeadingAndTrailingNewLineInsertion(diffLines);
  if (highlighted.length === 0) {
    const line = prefix.split("\n").slice(-1)[0];
    const indentation = line.slice(0, line.length - line.trimStart().length);
    diffLines = addIndentation(diffLines, indentation);
  }

  for await (const diffLine of diffLines) {
    yield diffLine;
  }
}
