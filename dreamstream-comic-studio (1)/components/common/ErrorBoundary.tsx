import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '../Button';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('Uncaught error:', error, errorInfo);
    }

    private handleReload = () => {
        window.location.reload();
    };

    public render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
                    <div className="bg-white rounded-xl shadow-comic border-4 border-black p-8 max-w-md w-full text-center space-y-4">
                        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto">
                            <AlertTriangle className="w-8 h-8 text-red-500" />
                        </div>
                        <h1 className="text-2xl font-display font-bold">Oops! Something went wrong.</h1>
                        <p className="text-gray-600 font-comic">
                            The comic studio encountered an unexpected error.
                        </p>
                        {this.state.error && (
                            <div className="text-xs text-left bg-gray-100 p-2 rounded border border-gray-200 overflow-auto max-h-32 font-mono">
                                {this.state.error.message}
                            </div>
                        )}
                        <div className="pt-4">
                            <Button onClick={this.handleReload} icon={<RefreshCw className="w-4 h-4" />}>
                                Reload Application
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
