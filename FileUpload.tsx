'use client';

import { useCallback, useState } from 'react';

interface FileUploadProps {
  onUpload: (file: File, payload?: any) => void;
  isConverting: boolean;
  mode: 'oas' | 'validate';
  savedValidationData?: any;
  savedFile?: File | null;
}

export default function FileUpload({ onUpload, isConverting, mode, savedValidationData, savedFile }: FileUploadProps) {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(savedFile || null);
  const [payload, setPayload] = useState<string>(savedValidationData?.payload ? JSON.stringify(savedValidationData.payload, null, 2) : '');
  const [path, setPath] = useState<string>(savedValidationData?.path || '/');
  const [method, setMethod] = useState<string>(savedValidationData?.method || 'GET');
  const [validationType, setValidationType] = useState<'request' | 'response'>(savedValidationData?.type || 'request');

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        const file = e.dataTransfer.files[0];
        if (file.name.endsWith('.zip')) {
          setSelectedFile(file);
        } else {
          alert('Please upload a ZIP file');
        }
      }
    },
    []
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.name.endsWith('.zip')) {
        setSelectedFile(file);
      } else {
        alert('Please upload a ZIP file');
      }
    }
  };

  const handleConvert = () => {
    if (selectedFile) {
      if (mode === 'validate') {
        // Validate that all required fields are filled
        // For GET/HEAD/DELETE request validation, payload is optional
        const isPayloadOptional = validationType === 'request' && ['GET', 'HEAD', 'DELETE'].includes(method);
        
        if (!path || !method) {
          alert('Please fill in API Path and Method');
          return;
        }
        
        if (!payload && !isPayloadOptional) {
          alert('Please fill in JSON Payload');
          return;
        }
        
        // For GET/HEAD/DELETE with no payload, send empty object
        if (!payload && isPayloadOptional) {
          onUpload(selectedFile, {
            payload: {},
            path,
            method,
            type: validationType
          });
          return;
        }
        
        try {
          const payloadObj = JSON.parse(payload);
          onUpload(selectedFile, {
            payload: payloadObj,
            path,
            method,
            type: validationType
          });
        } catch (e) {
          alert('Invalid JSON payload: ' + (e instanceof Error ? e.message : 'Unknown error'));
          return;
        }
      } else {
        onUpload(selectedFile);
      }
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-2xl p-8 md:p-12">
      <div
        className={`relative border-2 border-dashed rounded-xl p-12 text-center transition-all ${
          dragActive
            ? 'border-primary-500 bg-primary-50'
            : 'border-gray-300 bg-gray-50'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        {!selectedFile && (
          <input
            type="file"
            accept=".zip"
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            disabled={isConverting}
          />
        )}

        <div className="space-y-4">
          <div className="flex justify-center">
            <svg
              className={`w-20 h-20 ${
                dragActive ? 'text-primary-500' : 'text-gray-400'
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>

          <div>
            <p className="text-xl font-semibold text-gray-700 mb-2">
              {selectedFile ? selectedFile.name : mode === 'validate' ? 'Drop your OAS ZIP file here' : 'Drop your RAML ZIP file here'}
            </p>
            {!selectedFile && (
              <p className="text-sm text-gray-500">
                or click to browse
              </p>
            )}
          </div>

          {selectedFile && mode === 'validate' && (
            <div className="pt-4 space-y-4 w-full max-w-2xl mx-auto">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    API Path:
                  </label>
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/users/{id}"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-2">
                    Method:
                  </label>
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Validation Type:
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="request"
                      checked={validationType === 'request'}
                      onChange={(e) => setValidationType(e.target.value as 'request' | 'response')}
                      className="mr-2"
                    />
                    Request Body
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      value="response"
                      checked={validationType === 'response'}
                      onChange={(e) => setValidationType(e.target.value as 'request' | 'response')}
                      className="mr-2"
                    />
                    Response Body
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  JSON Payload{validationType === 'request' && ['GET', 'HEAD', 'DELETE'].includes(method) ? ' (Optional for ' + method + ')' : ''}:
                </label>
                <textarea
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder={
                    validationType === 'request' && ['GET', 'HEAD', 'DELETE'].includes(method)
                      ? 'Optional - Leave empty for parameter-based requests'
                      : '{"id": 123, "name": "John Doe"}'
                  }
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent font-mono text-sm"
                />
                {validationType === 'request' && ['GET', 'HEAD', 'DELETE'].includes(method) && (
                  <p className="mt-1 text-xs text-gray-500">
                    💡 {method} requests typically use URL parameters. Leave payload empty to validate the endpoint exists.
                  </p>
                )}
              </div>
            </div>
          )}

          {selectedFile && (
            <div className="pt-4 space-y-4">
              {mode === 'oas' && (
                <p className="text-sm text-gray-600">
                  File size: {(selectedFile.size / 1024).toFixed(2)} KB
                </p>
              )}
              <div className="flex gap-3 justify-center">
                <button
                  onClick={handleConvert}
                  disabled={
                    isConverting || 
                    (mode === 'validate' && validationType === 'response' && !payload) ||
                    (mode === 'validate' && validationType === 'request' && !['GET', 'HEAD', 'DELETE'].includes(method) && !payload)
                  }
                  className="relative z-10 bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 text-white font-semibold py-3 px-8 rounded-lg transition-colors duration-200 shadow-lg hover:shadow-xl"
                >
                  {isConverting ? (
                    <span className="flex items-center gap-2">
                      <svg
                        className="animate-spin h-5 w-5"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        ></circle>
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                      </svg>
                      {mode === 'oas' ? 'Converting...' : 'Validating...'}
                    </span>
                  ) : (
                    mode === 'oas' ? 'Convert to OAS' : 'Validate'
                  )}
                </button>
                <button
                  onClick={() => setSelectedFile(null)}
                  disabled={isConverting}
                  className="relative z-10 bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 text-gray-700 font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
                >
                  Change File
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 text-sm text-gray-600">
        <p className="font-semibold mb-2">Supported formats:</p>
        <ul className="list-disc list-inside space-y-1">
          <li>{mode === 'validate' ? 'OpenAPI 3.0 specification' : 'RAML 0.8 and 1.0'}</li>
          <li>Multi-file projects with folder structure</li>
          <li>{mode === 'validate' ? 'JSON request/response payloads' : 'Includes, traits, resource types, and data types'}</li>
          <li>
            {mode === 'oas' 
              ? 'Converts to OpenAPI 3.0 specification'
              : 'Validates payload against OAS schema definitions'
            }
          </li>
        </ul>
      </div>
    </div>
  );
}
