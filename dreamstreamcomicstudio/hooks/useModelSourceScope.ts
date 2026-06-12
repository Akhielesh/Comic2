// Live model-source scope for React surfaces.
//
// Wraps services/sourceGovernance.getModelSourceScope() and re-derives whenever the
// Settings toggles OR the key store change, so the Model Library, the comic Model
// panel and the chat picker always agree on which sources' models are shown.

import { useEffect, useState } from 'react';
import { API_KEYS_CHANGED } from '../services/apiKeys';
import {
  getModelSourceScope,
  SOURCE_GOVERNANCE_CHANGED,
  type ModelSourceScope
} from '../services/sourceGovernance';

export const useModelSourceScope = (): ModelSourceScope => {
  const [scope, setScope] = useState<ModelSourceScope>(() => getModelSourceScope());

  useEffect(() => {
    const update = () => setScope(getModelSourceScope());
    window.addEventListener(SOURCE_GOVERNANCE_CHANGED, update);
    window.addEventListener(API_KEYS_CHANGED, update);
    return () => {
      window.removeEventListener(SOURCE_GOVERNANCE_CHANGED, update);
      window.removeEventListener(API_KEYS_CHANGED, update);
    };
  }, []);

  return scope;
};
