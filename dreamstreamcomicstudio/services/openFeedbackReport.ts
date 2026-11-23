/** Opens the shared report dialog from a studio or the public home page. */
export function openFeedbackReport(kind: 'feedback' | 'bug' = 'feedback', editorialContext?: string) {
  window.dispatchEvent(new CustomEvent('dreamstream:open-feedback-report', { detail: { kind, editorialContext } }));
}
