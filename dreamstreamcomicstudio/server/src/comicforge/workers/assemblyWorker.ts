export const runAssemblyWorker = async (payload: Record<string, unknown>) => {
  return {
    assembled: true,
    payload,
    completedAt: Date.now()
  };
};
