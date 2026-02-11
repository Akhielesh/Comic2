import { createClient } from './client.js';
import { buildUsage } from './usage.js';
import { withRetry, withTimeout } from './utils.js';
import { TEXT_MODEL, ASSISTANT_REQUEST_TIMEOUT_MS } from '../config.js';
import { MasterAssistantContext, MasterAssistantResponse, StoryAssistantResponse } from '../../../apiTypes.js';
import { AppStep } from '../../../types.js';

const resolveTextModel = (modelOverride?: string) => {
  const candidate = modelOverride?.trim();
  return candidate || TEXT_MODEL;
};

export const queryStoryAssistant = async (
  apiKey: string,
  script: string,
  message: string,
  history: { role: 'user' | 'model'; text: string }[],
  modelOverride?: string
): Promise<StoryAssistantResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const systemInstruction = `You are an AI Assistant for a comic book. 
            You have access to the script of the story. 
            Your job is to answer reader questions about the plot, characters, and world, strictly based on the script provided. 
            Do not invent facts. If the script doesn't say, say you don't know.
            Be fun and engaging, like a fan club president.

            Response format (Markdown):
            **Summary:** 1-2 sentence answer.
            **Steps:** Use a numbered list only if the user asked for actions or a process.
            **Warnings:** Only if there's a risk or confusion.
            **Next:** 1-2 next actions or suggestions if helpful.
            Use **bold** for labels, *italics* for emphasis, and <u>underline</u> very sparingly for critical highlights.
            Keep it concise and avoid unnecessary sections.
            
            The Script:
            ${script}
            `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: systemInstruction }] },
          ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
          { role: 'user', parts: [{ text: message }] }
        ]
      }),
      ASSISTANT_REQUEST_TIMEOUT_MS,
      'Story assistant'
    ),
    2,
    1000,
    'Story Assistant'
  );

  const responseText = response.text || '';
  return {
    text: responseText,
    prompt: `${systemInstruction}\n\nUser: ${message}`,
    responseText,
    usage: buildUsage(message, responseText, response.usageMetadata),
    model
  };
};

export const queryMasterAssistant = async (
  apiKey: string,
  userMessage: string,
  history: { role: 'user' | 'model'; text: string }[],
  context: MasterAssistantContext,
  modelOverride?: string
): Promise<MasterAssistantResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);

  const projectSummary = context.project ? {
    name: context.project.name,
    step: AppStep[context.project.state.step],
    scenesCount: context.project.state.scenes.length,
    charsCount: context.project.state.characters.length,
    panelsCount: context.project.state.panels.length,
    isGenerating: context.project.state.generationStatus?.isActive,
    generationProgress: context.project.state.generationStatus?.progress,
    generationStep: context.project.state.generationStatus?.currentStepDescription,
    scriptLength: context.project.state.script.length,
    layoutType: context.project.state.layoutType,
    textLayout: context.project.state.textLayout || 'caption',
    coverReady: !!context.project.state.coverImageId,
    styleCategory: context.project.state.styleCategory,
    styleAspectRatio: context.project.state.styleAspectRatio,
    customAspectRatio: context.project.state.customAspectRatioEnabled ? context.project.state.customAspectRatio : undefined,
    imageResolution: context.project.state.imageResolution,
    overview: context.project.state.overview || '',
    commentsCount: context.project.state.comments?.length || 0,
    scriptChecklist: context.project.state.scriptChecklist
  } : 'No active project';

  const systemPrompt = `
        You are the "DreamStream Master Assistant".
        You are an expert on the DreamStream Comic Studio web application.
        You have access to the user's realtime application state.

        Your goals:
        1. Help the user navigate the app.
        2. Debug issues (e.g., if Scenes count is 0 and they are in Style step, tell them to go back to Script).
        3. Explain features (e.g., "World Builder allows you to create character sheets").
        4. Be encouraging and creative.

        Current App State:
        - View: ${context.view}
        - Project Summary: ${JSON.stringify(projectSummary)}
        - Panel Plan Summary: ${JSON.stringify(context.panelPlanSummary || {})}
        - Artifact Summary: ${JSON.stringify(context.artifactSummary || {})}
        - Report Summary (cost/storage/usage): ${JSON.stringify(context.reportSummary || {})}
        - Pricing Config: ${JSON.stringify(context.pricingConfig || {})}
        - All Projects Summary: ${JSON.stringify(context.allProjectsSummary || [])}
        - Project Snapshot (detailed): ${JSON.stringify(context.projectSnapshot || {})}
        - App Snapshot (overview): ${JSON.stringify(context.appSnapshot || {})}
        - Test Lab Summary: ${JSON.stringify(context.testLabSummary || {})}
        - Test Lab Recent Runs: ${JSON.stringify(context.testLabRecentRuns || [])}
        
        If the user asks "What is wrong?", look at the Project Summary. 
        - If scriptLength is 0, they need to write a script.
        - If scenesCount is 0 but they are past the script step, they probably skipped analysis.
        - If isGenerating is true, tell them to wait.
        If the user asks about other projects, use All Projects Summary to answer.
        If the user asks about costs, storage, downloads, or usage, use Report Summary and All Projects Summary.
        If the user asks about detailed content (panels, characters, scenes, comments), use Project Snapshot.
        If scriptChecklist shows missing items, proactively suggest how to fill them.
        If the user asks about Test Lab performance, use Test Lab Summary and Recent Runs.

        Response format (Markdown):
        **Summary:** 1-2 sentence answer.
        **Steps:** Use a numbered list only if the user asked for actions or a process.
        **Warnings:** Only if there's a risk or confusion.
        **Next:** 1-2 next actions or suggestions if helpful.
        Use **bold** for labels, *italics* for emphasis, and <u>underline</u> very sparingly for critical highlights.
        Keep it concise and avoid unnecessary sections.
    `;

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
          { role: 'user', parts: [{ text: userMessage }] }
        ]
      }),
      ASSISTANT_REQUEST_TIMEOUT_MS,
      'Assistant response'
    ),
    2,
    1000,
    'Assistant Query'
  );

  const responseText = response.text || '';
  return {
    text: responseText,
    prompt: `${systemPrompt}\n\nUser: ${userMessage}`,
    responseText,
    usage: buildUsage(userMessage, responseText, response.usageMetadata),
    model
  };
};
