import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import { validatePayload } from '@/lib/converter';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const payloadStr = formData.get('payload') as string;
    const path = formData.get('path') as string;
    const method = formData.get('method') as string;
    const type = formData.get('type') as string;
    const headersStr = formData.get('headers') as string;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!payloadStr || !path || !method) {
      return NextResponse.json(
        { error: 'Missing required fields: payload, path, or method' },
        { status: 400 }
      );
    }

    const payload = JSON.parse(payloadStr);
    const headers = headersStr ? JSON.parse(headersStr) : undefined;

    // Read the ZIP file
    const arrayBuffer = await file.arrayBuffer();
    const zip = new JSZip();
    const zipContents = await zip.loadAsync(arrayBuffer);

    // Extract all files from ZIP
    const files: { [key: string]: string } = {};
    const filePromises: Promise<void>[] = [];

    zipContents.forEach((relativePath, zipEntry) => {
      if (!zipEntry.dir) {
        filePromises.push(
          zipEntry.async('string').then((content) => {
            files[relativePath] = content;
          })
        );
      }
    });

    await Promise.all(filePromises);

    // Find the main OAS file - look for common OAS file names
    const mainOasFile = Object.keys(files).find(
      (filePath) => {
        const fileName = filePath.split('/').pop()?.toLowerCase() || '';
        return (
          fileName === 'openapi.yaml' || 
          fileName === 'openapi.yml' || 
          fileName === 'openapi.json' ||
          fileName === 'swagger.yaml' || 
          fileName === 'swagger.yml' || 
          fileName === 'swagger.json' ||
          fileName === 'api.yaml' || 
          fileName === 'api.yml' ||
          fileName === 'api.json'
        );
      }
    );

    if (!mainOasFile) {
      return NextResponse.json(
        { 
          error: 'No OpenAPI file found in ZIP. Expected: openapi.yaml, swagger.yaml, or api.yaml',
          availableFiles: Object.keys(files).filter(f => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.json'))
        },
        { status: 400 }
      );
    }

    // Validate payload
    const validation = await validatePayload(files, mainOasFile, {
      payload,
      path,
      method: method.toUpperCase(),
      type: type as 'request' | 'response',
      headers
    });

    return NextResponse.json({
      success: true,
      validation
    });

  } catch (error: any) {
    console.error('Validation error:', error);
    return NextResponse.json(
      { 
        error: error.message || 'Failed to validate payload',
        details: error.stack
      },
      { status: 500 }
    );
  }
}
