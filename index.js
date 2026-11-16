import React from 'react';
import { registerRootComponent } from 'expo';
import App from './App';
import SafeErrorBoundary from './SafeErrorBoundary';

function Root() { return <SafeErrorBoundary><App /></SafeErrorBoundary>; }
registerRootComponent(Root);
