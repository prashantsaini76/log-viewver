import * as yaml from 'js-yaml';

interface FileMap {
  [path: string]: string;
}

export interface ConversionResult {
  oas: any;
  yaml: string;
}

/**
 * Auto-fix common YAML indentation issues
 * This reduces user overhead by automatically correcting indentation problems
 */
function autoFixYamlIndentation(content: string): string {
  const lines = content.split('\n');
  const fixedLines: string[] = [];
  let fixCount = 0;
  const fixedIssues: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const originalLine = line;
    
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      fixedLines.push(line);
      continue;
    }
    
    // Fix 1: Convert tabs to spaces (most common issue)
    if (line.includes('\t')) {
      line = line.replace(/\t/g, '  ');
      fixCount++;
      fixedIssues.push(`Line ${i + 1}: Converted tabs to spaces`);
    }
    
    // Fix 2: Fix odd-numbered indentation (normalize to even spaces)
    const leadingSpaces = line.match(/^( +)/)?.[1]?.length || 0;
    if (leadingSpaces > 0 && leadingSpaces % 2 !== 0) {
      // Round up to next even number
      const normalizedIndent = Math.ceil(leadingSpaces / 2) * 2;
      const content = line.trim();
      line = ' '.repeat(normalizedIndent) + content;
      fixCount++;
      fixedIssues.push(`Line ${i + 1}: Fixed odd indentation (${leadingSpaces} → ${normalizedIndent} spaces)`);
    }
    
    fixedLines.push(line);
  }
  
  // Log fixes if any were made
  if (fixCount > 0 && process.env.NODE_ENV !== 'production') {
    console.log(`\n✨ Auto-fixed ${fixCount} indentation issue(s):`);
    fixedIssues.slice(0, 10).forEach(issue => console.log(`   ${issue}`));
    if (fixedIssues.length > 10) {
      console.log(`   ... and ${fixedIssues.length - 10} more`);
    }
    console.log('');
  }
  
  return fixedLines.join('\n');
}

/**
 * Convert RAML to OpenAPI Specification (OAS)
 * Supports multi-file RAML projects with includes and references
 */
export async function convertRamlToOas(
  files: FileMap,
  mainRamlFile: string
): Promise<ConversionResult> {
  try {
    // Get the main RAML content
    const mainRamlContent = files[mainRamlFile];
    if (!mainRamlContent) {
      throw new Error(`Main RAML file not found: ${mainRamlFile}`);
    }

    // First, resolve all !include directives (keep resolving until no more includes)
    let resolvedContent = mainRamlContent;
    let maxIterations = 10; // Prevent infinite loops
    let iteration = 0;
    
    while (resolvedContent.includes('!include') && iteration < maxIterations) {
      resolvedContent = resolveIncludes(resolvedContent, files, mainRamlFile);
      iteration++;
    }
    
    if (resolvedContent.includes('!include')) {
      console.warn('Warning: Some !include directives may not have been resolved after 10 iterations');
    }

    // Then, resolve libraries referenced with 'uses:' (AFTER includes are resolved)
    const { content: libraryResolvedContent, libraries } = resolveLibraries(resolvedContent, files, mainRamlFile);

    // Auto-fix common YAML indentation issues before parsing
    const fixedContent = autoFixYamlIndentation(libraryResolvedContent);

    // Parse the resolved RAML as YAML
    let ramlData;
    try {
      ramlData = yaml.load(fixedContent) as any;
    } catch (yamlError: any) {
      // Enhanced error reporting for YAML parsing issues
      const errorMsg = yamlError instanceof Error ? yamlError.message : 'Unknown error';
      const errorReason = yamlError.reason || '';
      
      // Save the problematic content for debugging (Node.js only)
      let debugFilePath = '';
      try {
        if (typeof process !== 'undefined' && process.versions && process.versions.node) {
          // We're in Node.js
          const fs = require('fs');
          debugFilePath = 'raml-debug-output.yaml';
          fs.writeFileSync(debugFilePath, fixedContent, 'utf-8');
          console.log(`\n⚠️  Debug: Saved problematic content to ${debugFilePath} for inspection\n`);
        }
      } catch (e) {
        // Ignore file write errors
      }
      
      // Check if there are unresolved !include directives
      const unresolvedIncludes = fixedContent.match(/!include\s+[^\n]+/g);
      if (unresolvedIncludes) {
        throw new Error(
          `YAML parsing failed. Found unresolved !include directives:\n${unresolvedIncludes.join('\n')}\n\nOriginal error: ${errorMsg}`
        );
      }
      
      // Try to find the problematic section by parsing the error line number
      let problematicContent = '';
      if (yamlError.mark && yamlError.mark.line !== undefined) {
        const errorLine = yamlError.mark.line;
        const lines = fixedContent.split('\n');
        
        // Show context around the error
        const contextStart = Math.max(0, errorLine - 5);
        const contextEnd = Math.min(lines.length, errorLine + 5);
        const contextLines = [];
        
        for (let i = contextStart; i < contextEnd; i++) {
          const lineNum = i + 1;
          const prefix = lineNum === errorLine + 1 ? '>>> ' : '    ';
          contextLines.push(`${prefix}${lineNum}: ${lines[i]}`);
        }
        
        problematicContent = '\n\nContext around error:\n' + contextLines.join('\n');
      }
      
      // Enhanced error message
      const debugFileInfo = debugFilePath ? `\n- Review the file: ${debugFilePath} (saved in your project root)` : '';
      const enhancedError = `YAML Indentation Error in ${mainRamlFile}

${errorReason ? `Reason: ${errorReason}` : ''}

⚠️  Note: Auto-fix attempted but couldn't resolve this issue automatically.

This error typically means:
1. Inconsistent indentation (mixing spaces and tabs)
2. Wrong number of spaces for nested properties
3. Missing or extra spaces before property names
4. Quoted strings with special characters not properly escaped
5. Example values with special characters (like "300001Type") need proper quotes

${problematicContent}

Full error: ${errorMsg}

💡 Tips to fix:
- Check that all indentation uses spaces (not tabs)
- Verify nested properties are indented by exactly 2 spaces
- Look for properties with colons in values - they may need quotes
- Check 'example:' values - strings should be in quotes: example: "value"${debugFileInfo}
- Use a YAML validator: https://www.yamllint.com/`;
      
      throw new Error(enhancedError);
    }

    if (!ramlData || typeof ramlData !== 'object') {
      throw new Error('Invalid RAML format');
    }

    // Resolve traits and apply them to methods (pass libraries for namespaced traits)
    ramlData = resolveTraits(ramlData, libraries);

    // Convert RAML to OpenAPI
    const oasSpec = convertRamlToOasSpec(ramlData);

    // Convert to YAML
    const yamlOutput = yaml.dump(oasSpec, { indent: 2, lineWidth: -1 });

    return {
      oas: oasSpec,
      yaml: yamlOutput,
    };
  } catch (error) {
    console.error('RAML to OAS conversion error:', error);
    
    // Create detailed error message with context
    let errorMessage = 'Failed to convert RAML to OAS';
    
    if (error instanceof Error) {
      errorMessage += `: ${error.message}`;
      
      // Add file context if available in stack trace
      if (error.stack) {
        const fileMatch = error.stack.match(/at\s+.*?\((.+?):\d+:\d+\)/);
        if (fileMatch) {
          errorMessage += `\n\nError occurred in: ${fileMatch[1]}`;
        }
      }
    }
    
    // Add the main RAML file being processed
    errorMessage += `\n\nProcessing file: ${mainRamlFile}`;
    
    throw new Error(errorMessage);
  }
}

/**
 * Resolve local type references within a library's types collection
 * E.g., if UserLogDetlPostReq references another type in the same library
 */
function resolveLocalTypeReferences(types: any, maxDepth = 10): any {
  if (!types || maxDepth <= 0) return types;
  
  const resolved: any = {};
  
  // First, copy all types as-is
  for (const typeName in types) {
    resolved[typeName] = types[typeName];
  }
  
  // Then, recursively resolve type references
  for (const typeName in resolved) {
    resolved[typeName] = resolveTypeInObject(resolved[typeName], types, maxDepth - 1);
  }
  
  return resolved;
}

/**
 * Recursively resolve type references in an object
 */
function resolveTypeInObject(obj: any, types: any, depth: number): any {
  if (depth <= 0 || !obj || typeof obj !== 'object') {
    return obj;
  }
  
  // If this is a direct type reference (string), try to expand it
  if (typeof obj === 'string' && types[obj]) {
    return resolveTypeInObject(types[obj], types, depth - 1);
  }
  
  // If obj has a 'type' property that references another type
  if (obj.type && typeof obj.type === 'string' && types[obj.type]) {
    // Expand the type reference
    const expandedType = resolveTypeInObject(types[obj.type], types, depth - 1);
    
    // Merge expanded type with current properties
    const result = { ...expandedType };
    
    // Keep other properties from the original object
    for (const key in obj) {
      if (key !== 'type') {
        if (key === 'properties' && result.properties) {
          // Merge properties objects and recursively resolve them
          const mergedProps = { ...result.properties, ...obj[key] };
          result[key] = {};
          for (const propName in mergedProps) {
            result[key][propName] = resolveTypeInObject(mergedProps[propName], types, depth - 1);
          }
        } else {
          result[key] = obj[key];
        }
      }
    }
    
    return result;
  }
  
  // Recursively process nested objects
  const result: any = Array.isArray(obj) ? [] : {};
  
  for (const key in obj) {
    const value = obj[key];
    
    if (key === 'properties' && typeof value === 'object') {
      // Recursively resolve types in properties
      result[key] = {};
      for (const propName in value) {
        result[key][propName] = resolveTypeInObject(value[propName], types, depth - 1);
      }
    } else if (key === 'items') {
      // Handle array items - can be a string reference or an object
      if (typeof value === 'string' && types[value]) {
        // items is a type reference string like "customerGetResponse"
        result[key] = resolveTypeInObject(types[value], types, depth - 1);
      } else if (typeof value === 'object') {
        // items is an object definition
        result[key] = resolveTypeInObject(value, types, depth - 1);
      } else if (typeof value === 'string') {
        // items is a string but not a type reference (e.g., "string", "number")
        result[key] = value;
      } else {
        result[key] = value;
      }
    } else if (key === 'type' && typeof value === 'string' && types[value]) {
      // Already handled above at line 259-272, but keep the property
      result[key] = value;
    } else if (typeof value === 'object') {
      result[key] = resolveTypeInObject(value, types, depth - 1);
    } else if (typeof value === 'string' && types[value]) {
      // Any other property that's a string and matches a type name
      result[key] = resolveTypeInObject(types[value], types, depth - 1);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Resolve library imports (uses: keyword)
 * Returns an object with the resolved content and the libraries
 */
function resolveLibraries(content: string, files: FileMap, currentFile: string): { content: string; libraries: { [key: string]: any } } {
  const lines = content.split('\n');
  let inUsesBlock = false;
  let usesIndent = 0;
  const libraries: { [key: string]: any } = {};
  
  // Debug
  let usesFound = false;
  
  // First pass: extract libraries
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'uses:') {
      inUsesBlock = true;
      usesFound = true;
      usesIndent = line.search(/\S/);
      if (process.env.NODE_ENV !== 'production') {
        console.log('Found uses: block at line', i);
      }
      continue;
    }
    
    if (inUsesBlock) {
      const lineIndent = line.search(/\S/);
      
      // Check if we're still in the uses block
      if (lineIndent <= usesIndent && trimmed !== '') {
        inUsesBlock = false;
        continue;
      }
      
      if (trimmed && trimmed.includes(':')) {
        // Remove inline comments (everything after #)
        const lineWithoutComment = trimmed.split('#')[0].trim();
        const [libName, libPath] = lineWithoutComment.split(':').map(s => s.trim());
        
        if (process.env.NODE_ENV !== 'production') {
          console.log(`  Library found: ${libName} -> ${libPath}`);
        }
        
        // Resolve library file path
        const currentDir = currentFile.split('/').slice(0, -1).join('/');
        let resolvedPath = currentDir ? `${currentDir}/${libPath}` : libPath;
        resolvedPath = resolvedPath.replace(/\/\.\//g, '/');
        
        let libContent = files[resolvedPath] || files[libPath];
        
        if (!libContent) {
          for (const filePath in files) {
            if (filePath.endsWith(libPath) || filePath === resolvedPath) {
              libContent = files[filePath];
              resolvedPath = filePath;
              break;
            }
          }
        }
        
        if (libContent) {
          // Resolve includes in library
          if (libContent.includes('!include')) {
            try {
              libContent = resolveIncludes(libContent, files, resolvedPath);
              
              // Debug: Save resolved library content for inspection
              if (process.env.NODE_ENV !== 'production') {
                console.log(`    Library ${libName} after resolving includes (first 30 lines):`);
                libContent.split('\n').slice(0, 30).forEach((line, idx) => {
                  console.log(`      ${idx + 1}: ${line}`);
                });
              }
            } catch (includeError) {
              const errorMsg = `Failed to resolve includes in library ${libName} from ${libPath}: ${includeError instanceof Error ? includeError.message : 'Unknown error'}`;
              console.error(errorMsg);
              throw new Error(errorMsg);
            }
          }
          
          // Check for circular reference in uses: block
          if (libContent.includes('uses:')) {
            const usesMatch = libContent.match(/uses:\s*\n\s+(\w+):\s*(.+)/);
            if (usesMatch) {
              const subLibPath = usesMatch[2].split('#')[0].trim();
              // Check if the library is trying to import itself (circular reference)
              if (subLibPath === libPath || resolvedPath.endsWith(subLibPath)) {
                if (process.env.NODE_ENV !== 'production') {
                  console.warn(`    ⚠️  Circular reference detected: ${libPath} is trying to import itself. Removing uses: block.`);
                }
                // Remove the uses: block to prevent circular reference
                libContent = libContent.replace(/uses:\s*\n(\s+\w+:\s*.+\n?)+/g, '');
              }
            }
          }
          
          // Parse library content
          try {
            const libData = yaml.load(libContent) as any;
            
            // Resolve local type references within the library
            if (libData.types) {
              libData.types = resolveLocalTypeReferences(libData.types);
            }
            
            libraries[libName] = libData;
            
            if (process.env.NODE_ENV !== 'production') {
              console.log(`    Loaded library ${libName} with types:`, libData.types ? Object.keys(libData.types) : 'none');
            }
          } catch (e) {
            const errorMsg = `Failed to parse library ${libName} from ${libPath} in file: ${currentFile}`;
            console.error(errorMsg);
            
            // Add more context about the error
            if (e instanceof Error) {
              console.error('YAML Parse Error:', e.message);
              console.error('Error name:', e.name);
              
              // Show a snippet of the library content that failed to parse
              const lines = libContent.split('\n');
              console.error(`\nLibrary content (first 20 lines):`);
              lines.slice(0, 20).forEach((line, idx) => {
                console.error(`  ${idx + 1}: ${line}`);
              });
              
              if (lines.length > 20) {
                console.error(`  ... and ${lines.length - 20} more lines`);
              }
              
              if (e.message.includes('unknown tag')) {
                console.error('\n💡 Tip: This library may contain unresolved !include directives or RAML-specific syntax.');
              }
              if (libContent.includes('uses:')) {
                console.error('\n💡 Tip: This library has a "uses:" block - it may be importing other libraries that need to be resolved first.');
              }
            }
            
            throw new Error(`${errorMsg}\nOriginal error: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          const errorMsg = `Library file not found: ${libName} at path ${libPath} (referenced in file: ${currentFile})`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }
      }
    }
  }
  
  if (!usesFound && process.env.NODE_ENV !== 'production') {
    console.log('No uses: block found in content');
  }
  
  // Second pass: replace library type references with actual type definitions
  let result = content;
  
  for (const libName in libraries) {
    const lib = libraries[libName];
    
    // Replace type references like CommonTypes.User[] or ErrorTypes.ErrorResponse
    if (lib.types) {
      for (const typeName in lib.types) {
        const fullTypeName = `${libName}.${typeName}`;
        const typeData = lib.types[typeName];
        
        if (process.env.NODE_ENV !== 'production') {
          console.log(`  Replacing ${fullTypeName}...`);
        }
        
        // Handle array types like CommonTypes.User[]
        const arrayRegex = new RegExp(`([ \\t]*)(type):\\s*${fullTypeName.replace('.', '\\.')}\\[\\]`, 'g');
        result = result.replace(arrayRegex, (match, leadingSpaces, typeKeyword) => {
          const baseIndent = leadingSpaces.length;
          const sameIndent = ' '.repeat(baseIndent);
          const propsIndent = ' '.repeat(baseIndent + 2);
          
          if (process.env.NODE_ENV !== 'production') {
            console.log(`    Match: "${match}", leadingSpaces.length=${leadingSpaces.length}, baseIndent=${baseIndent}`);
          }
          
          // Dump the type data and indent it properly
          const yamlStr = yaml.dump(typeData, { indent: 2, lineWidth: -1 });
          const lines = yamlStr.trim().split('\n');
          const indentedProps = lines.map(line => propsIndent + line).join('\n');
          
          const replacement = `${leadingSpaces}${typeKeyword}: array\n${sameIndent}items:\n${indentedProps}`;
          
          if (process.env.NODE_ENV !== 'production') {
            console.log(`    Array replacement:\n"${replacement.substring(0, 100)}"`);
          }
          return replacement;
        });
        
        // Handle single type references like CommonTypes.User
        const singleRegex = new RegExp(`([ \\t]*)(type):\\s*${fullTypeName.replace('.', '\\.')}(?!\\[)`, 'g');
        result = result.replace(singleRegex, (match, leadingSpaces, typeKeyword) => {
          const baseIndent = leadingSpaces.length;
          const propsIndent = ' '.repeat(baseIndent + 2);
          
          // Dump the type data and indent it properly
          const yamlStr = yaml.dump(typeData, { indent: 2, lineWidth: -1 });
          const lines = yamlStr.trim().split('\n');
          const indentedProps = lines.map(line => propsIndent + line).join('\n');
          
          const replacement = `${leadingSpaces}${typeKeyword}:\n${indentedProps}`;
          
          if (process.env.NODE_ENV !== 'production') {
            console.log(`    Single replacement (indent=${baseIndent}):\n${replacement.substring(0, 200)}`);
          }
          return replacement;
        });
      }
    }
  }
  
  // Debug: Log result after all replacements
  if (process.env.NODE_ENV !== 'production') {
    console.log('=== After all library type replacements ===');
    console.log(result.substring(result.indexOf('/users'), result.indexOf('/users') + 500));
    console.log('...\n');
  }
  
  // Remove the uses: block from content
  const resultLines = result.split('\n'); // Use result, not lines!
  const cleanedLines: string[] = [];
  inUsesBlock = false;
  
  for (let i = 0; i < resultLines.length; i++) {
    const line = resultLines[i];
    const trimmed = line.trim();
    
    if (trimmed === 'uses:') {
      inUsesBlock = true;
      usesIndent = line.search(/\S/);
      continue;
    }
    
    if (inUsesBlock) {
      const lineIndent = line.search(/\S/);
      if (lineIndent <= usesIndent && trimmed !== '') {
        inUsesBlock = false;
        cleanedLines.push(line);
      }
    } else {
      cleanedLines.push(line);
    }
  }
  
  return { content: cleanedLines.join('\n'), libraries };
}

/**
 * Helper function to indent YAML content
 */
function indentYaml(obj: any, spaces: number, includeTypePrefix = false): string {
  const yamlStr = yaml.dump(obj, { indent: 2, lineWidth: -1 });
  const lines = yamlStr.trim().split('\n');
  const indent = ' '.repeat(spaces);
  
  if (includeTypePrefix && lines.length > 0) {
    // For inline type replacement, first line should be "type: " + first property
    const firstLine = lines[0];
    const restLines = lines.slice(1).map(line => indent + line).join('\n');
    return `type:\n${indent}${firstLine}\n${restLines}`;
  }
  
  return lines.map(line => indent + line).join('\n');
}

/**
 * Resolve all !include directives in RAML content
 */
function resolveIncludes(content: string, files: FileMap, currentFile: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Remove carriage return if present (Windows line endings)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    
    // Pattern 1: "key: !include file.raml"
    const includeAfterColon = line.match(/^(\s*)(.+?):\s*!include\s+(.+)$/);
    
    // Pattern 2: "  !include file.raml" (entire value is include)
    const includeAsValue = line.match(/^(\s*)!include\s+(.+)$/);
    
    if (includeAfterColon) {
      const [, indent, key, includePath] = includeAfterColon;
      const fileContent = getIncludedContent(includePath.trim(), files, currentFile);
      
      if (fileContent === null) {
        const errorMsg = `Failed to resolve !include at line ${i + 1} in file: ${currentFile}\n  Include path: ${includePath.trim()}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // If empty string (skipped documentation), replace with placeholder text
      if (fileContent === '') {
        result.push(`${indent}${key}: "Documentation content skipped"`);
        continue;
      }
      
      // Add the key with proper indentation
      result.push(`${indent}${key}:`);
      
      // Add included content with additional indentation
      // Calculate the base indentation of the included file (from first non-empty line)
      const contentLines = fileContent.split('\n');
      let baseIndentOfIncludedFile = 0;
      for (const contentLine of contentLines) {
        if (contentLine.trim()) {
          baseIndentOfIncludedFile = contentLine.search(/\S/);
          break;
        }
      }
      
      const additionalIndent = indent + '  ';
      
      // Debug logging
      if (process.env.NODE_ENV !== 'production' && key.includes('Trait')) {
        console.log(`      Processing include for key "${key}" from ${includePath.trim()}`);
        console.log(`        Base indent: "${indent}" (${indent.length} spaces)`);
        console.log(`        Additional indent: "${additionalIndent}" (${additionalIndent.length} spaces)`);
        console.log(`        Base indent of included file: ${baseIndentOfIncludedFile}`);
        console.log(`        First 5 lines of included content:`);
        contentLines.slice(0, 5).forEach((line, idx) => {
          console.log(`          ${idx + 1}: [${line.search(/\S/)}] "${line}"`);
        });
      }
      for (const contentLine of contentLines) {
        if (contentLine.trim()) {
          // Remove the base indentation from the included file and add our indentation
          const lineIndent = contentLine.search(/\S/);
          const relativeIndent = Math.max(0, lineIndent - baseIndentOfIncludedFile);
          const newIndent = additionalIndent + ' '.repeat(relativeIndent);
          result.push(newIndent + contentLine.trim());
        } else {
          result.push(contentLine);
        }
      }
    } else if (includeAsValue) {
      const [, indent, includePath] = includeAsValue;
      const fileContent = getIncludedContent(includePath.trim(), files, currentFile);
      
      if (fileContent === null) {
        const errorMsg = `Failed to resolve !include at line ${i + 1} in file: ${currentFile}\n  Include path: ${includePath.trim()}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      // If empty string (skipped documentation), use placeholder
      if (fileContent === '') {
        result.push(`${indent}"Documentation content skipped"`);
        continue;
      }
      
      // Replace the !include line with the content (maintaining relative indentation)
      const contentLines = fileContent.split('\n');
      let baseIndentOfIncludedFile = 0;
      for (const contentLine of contentLines) {
        if (contentLine.trim()) {
          baseIndentOfIncludedFile = contentLine.search(/\S/);
          break;
        }
      }
      
      for (const contentLine of contentLines) {
        if (contentLine.trim()) {
          // Remove the base indentation from the included file and add our indentation
          const lineIndent = contentLine.search(/\S/);
          const relativeIndent = Math.max(0, lineIndent - baseIndentOfIncludedFile);
          const newIndent = indent + ' '.repeat(relativeIndent);
          result.push(newIndent + contentLine.trim());
        } else {
          result.push(contentLine);
        }
      }
    } else {
      // No include in this line, keep it as is
      result.push(line);
    }
  }
  
  return result.join('\n');
}

/**
 * Get included file content and resolve nested includes
 */
function getIncludedContent(includePath: string, files: FileMap, currentFile: string): string | null {
  // Skip documentation folders
  const docFolderPatterns = ['/doc/', '/docs/', '/documentation/', 'doc/', 'docs/', 'documentation/'];
  const shouldSkipDoc = docFolderPatterns.some(pattern => 
    includePath.includes(pattern) || currentFile.includes(pattern)
  );
  
  if (shouldSkipDoc) {
    console.log(`  Skipping documentation file: ${includePath}`);
    return ''; // Return empty string instead of null to avoid errors
  }
  
  // Get the directory of the current file
  const currentDir = currentFile.split('/').slice(0, -1).join('/');
  
  // Resolve the include path relative to current file
  let resolvedPath = currentDir ? `${currentDir}/${includePath}` : includePath;
  
  // Normalize path - handle ./ and ../
  resolvedPath = resolvedPath.replace(/\/\.\//g, '/'); // Remove ./
  
  // Handle ../ (parent directory)
  while (resolvedPath.includes('../')) {
    resolvedPath = resolvedPath.replace(/[^\/]+\/\.\.\//g, '');
  }
  
  // Remove leading slash if present
  resolvedPath = resolvedPath.replace(/^\/+/, '');
  
  // Try to find the file
  let fileContent = files[resolvedPath] || files[includePath];
  
  // Try without leading slash
  if (!fileContent && resolvedPath.startsWith('/')) {
    fileContent = files[resolvedPath.substring(1)];
  }
  
  // Try normalized paths
  if (!fileContent) {
    const normalizedPath = includePath.replace(/^\.\//, '');
    fileContent = files[normalizedPath];
    
    // Search through all files for a match
    for (const filePath in files) {
      // Normalize file paths for comparison
      const normalizedFilePath = filePath.replace(/^\/+/, '');
      const normalizedResolvedPath = resolvedPath.replace(/^\/+/, '');
      
      if (normalizedFilePath === normalizedResolvedPath) {
        fileContent = files[filePath];
        resolvedPath = filePath;
        break;
      }
      
      if (filePath.endsWith(includePath) || filePath.endsWith(normalizedPath)) {
        fileContent = files[filePath];
        resolvedPath = filePath;
        break;
      }
      
      // Try matching the full resolved path
      if (filePath === resolvedPath || filePath.endsWith(resolvedPath)) {
        fileContent = files[filePath];
        resolvedPath = filePath;
        break;
      }
    }
  }
  
  if (!fileContent) {
    console.warn(`Include file not found: ${includePath} (tried: ${resolvedPath})`);
    console.warn(`Current file: ${currentFile}`);
    console.warn(`Available files: ${Object.keys(files).join(', ')}`);
    return null;
  }
  
  // If the included file also has includes, resolve them recursively
  if (fileContent.includes('!include')) {
    fileContent = resolveIncludes(fileContent, files, resolvedPath);
  }
  
  // Remove RAML header from included content
  const contentLines = fileContent.split('\n');
  let startIndex = 0;
  
  // Skip RAML version header (e.g., "#%RAML 1.0 Trait")
  for (let j = 0; j < contentLines.length; j++) {
    const contentLine = contentLines[j].trim();
    if (contentLine.startsWith('#%RAML')) {
      startIndex = j + 1;
      break; // Only skip the RAML header line
    }
  }
  
  // Also skip any leading empty lines after the header
  while (startIndex < contentLines.length && !contentLines[startIndex].trim()) {
    startIndex++;
  }
  
  return contentLines.slice(startIndex).join('\n');
}

/**
 * Resolve traits (is: keyword) and merge into methods
 * Also merges traits from libraries (e.g., ct.TraitName)
 */
function resolveTraits(ramlData: any, libraries: { [key: string]: any } = {}): any {
  const traits: { [key: string]: any } = {};
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('=== resolveTraits called ===');
  }
  
  // Extract traits from RAML data
  if (ramlData.traits) {
    if (Array.isArray(ramlData.traits)) {
      // traits: [ { traitName: {...} }, ... ]
      ramlData.traits.forEach((traitObj: any) => {
        const traitName = Object.keys(traitObj)[0];
        traits[traitName] = traitObj[traitName];
      });
    } else {
      // traits: { traitName: {...}, ... }
      Object.assign(traits, ramlData.traits);
    }
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('  Found traits:', Object.keys(traits));
    }
  }
  
  // Extract traits from libraries (e.g., ct.TraitName)
  for (const libName in libraries) {
    const libData = libraries[libName];
    if (libData.traits) {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`  Found traits in library ${libName}:`, Object.keys(libData.traits));
      }
      
      // Add library traits with namespaced keys (e.g., ct.ReturnsSuccess)
      for (const traitName in libData.traits) {
        const namespacedKey = `${libName}.${traitName}`;
        traits[namespacedKey] = libData.traits[traitName];
      }
    }
  }
  
  // Apply traits to all methods that have "is:"
  function applyTraitsToResource(resource: any, inheritedTraits: string[] = []) {
    if (!resource) return;
    
    // Check for resource-level "is:" (traits applied to all methods in this resource)
    let resourceTraits: string[] = [...inheritedTraits];
    if (resource.is) {
      const localTraits = Array.isArray(resource.is) ? resource.is : [resource.is];
      resourceTraits = [...resourceTraits, ...localTraits];
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`  Resource-level traits found:`, localTraits);
      }
    }
    
    // Process each HTTP method
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
    for (const method of httpMethods) {
      if (resource[method]) {
        const methodData = resource[method];
        
        // Combine inherited traits with method-level traits
        let traitNames = [...resourceTraits];
        if (methodData.is) {
          const methodTraits = Array.isArray(methodData.is) ? methodData.is : [methodData.is];
          traitNames = [...traitNames, ...methodTraits];
          delete methodData.is;
        }
        
        if (traitNames.length > 0) {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`  Applying traits to ${method}:`, traitNames);
          }
          
          // Apply each trait in order
          for (const traitName of traitNames) {
            if (traits[traitName]) {
              const trait = traits[traitName];
              
              if (process.env.NODE_ENV !== 'production') {
                console.log(`    Merging trait ${traitName}:`, {
                  headers: trait.headers ? Object.keys(trait.headers) : 'none',
                  queryParameters: trait.queryParameters ? Object.keys(trait.queryParameters) : 'none'
                });
              }
              
              // Merge headers
              if (trait.headers) {
                methodData.headers = { ...trait.headers, ...(methodData.headers || {}) };
              }
              
              // Merge query parameters
              if (trait.queryParameters) {
                methodData.queryParameters = { ...trait.queryParameters, ...(methodData.queryParameters || {}) };
              }
              
              // Merge responses
              if (trait.responses) {
                methodData.responses = { ...trait.responses, ...(methodData.responses || {}) };
              }
              
              // Merge description
              if (trait.description && !methodData.description) {
                methodData.description = trait.description;
              }
            }
          }
        }
      }
    }
    
    // Remove resource-level "is:" after applying
    if (resource.is) {
      delete resource.is;
    }
    
    // Recursively process nested resources, passing down the traits
    for (const key in resource) {
      if (key.startsWith('/')) {
        applyTraitsToResource(resource[key], resourceTraits);
      }
    }
  }
  
  // Apply traits to all resources
  for (const key in ramlData) {
    if (key.startsWith('/')) {
      applyTraitsToResource(ramlData[key]);
    }
  }
  
  return ramlData;
}

/**
 * Convert resolved RAML data to OpenAPI 3.0 specification
 */
function convertRamlToOasSpec(ramlData: any): any {
  // Basic OAS 3.0 structure
  const oas: any = {
    openapi: '3.0.0',
    info: {
      title: ramlData.title || 'API',
      version: ramlData.version || '1.0.0',
      description: ramlData.description || '',
    },
    servers: [],
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {},
    },
  };

  // Convert base URI to servers
  if (ramlData.baseUri) {
    oas.servers.push({
      url: ramlData.baseUri.replace(/{version}/g, ramlData.version || '1.0.0'),
    });
  }

  // Convert protocols
  if (ramlData.protocols && ramlData.protocols.length > 0) {
    const protocol = ramlData.protocols[0].toLowerCase();
    if (!ramlData.baseUri) {
      oas.servers.push({ url: `${protocol}://example.com` });
    }
  }

  // Convert security schemes
  if (ramlData.securitySchemes) {
    for (const schemeName in ramlData.securitySchemes) {
      const scheme = ramlData.securitySchemes[schemeName];
      oas.components.securitySchemes[schemeName] = convertSecurityScheme(scheme);
    }
  }

  // Convert data types/schemas
  if (ramlData.types) {
    for (const typeName in ramlData.types) {
      const type = ramlData.types[typeName];
      oas.components.schemas[typeName] = convertDataType(type);
    }
  }

  // Extract traits for use in resources
  const traits = ramlData.traits || {};

  // Convert resources (endpoints) - iterate over keys starting with '/'
  for (const key in ramlData) {
    if (key.startsWith('/')) {
      convertResource(key, ramlData[key], oas.paths, '', traits);
    }
  }

  return oas;
}

/**
 * Convert a single RAML resource to OAS path
 */
function convertResource(path: string, resource: any, paths: any, parentPath: string, traits?: any) {
  const fullPath = parentPath + path;
  
  if (!paths[fullPath]) {
    paths[fullPath] = {};
  }
  
  // Extract URI parameters from path (like /{id} or /{userId})
  const pathParams: any = {};
  const pathParamMatches = fullPath.matchAll(/\{([^}]+)\}/g);
  for (const match of pathParamMatches) {
    const paramName = match[1];
    pathParams[paramName] = {
      type: 'string',
      required: true,
    };
  }
  
  // Merge resource-level uriParameters with extracted path params
  if (resource.uriParameters) {
    Object.assign(pathParams, resource.uriParameters);
  }

  // Convert HTTP methods (get, post, put, delete, etc.)
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
  
  for (const method of httpMethods) {
    if (resource[method]) {
      paths[fullPath][method] = convertMethod(resource[method], method, traits, pathParams);
    }
  }

  // Recursively process nested resources
  for (const key in resource) {
    if (key.startsWith('/')) {
      convertResource(key, resource[key], paths, fullPath, traits);
    }
  }
}

/**
 * Convert RAML method to OAS operation
 */
function convertMethod(methodData: any, methodName?: string, traits?: any, pathParams?: any): any {
  // Apply traits if the method uses them (is: [trait1, trait2])
  if (methodData.is && Array.isArray(methodData.is) && traits) {
    for (const traitName of methodData.is) {
      if (traits[traitName]) {
        // Merge trait properties into method
        methodData = { ...traits[traitName], ...methodData };
      }
    }
  }

  const operation: any = {
    summary: methodData.displayName || methodData.description || (methodName ? methodName.toUpperCase() : 'Operation'),
    description: methodData.description || '',
    responses: {},
  };

  // Add path parameters first
  if (pathParams && Object.keys(pathParams).length > 0) {
    operation.parameters = [];
    for (const paramName in pathParams) {
      const param = pathParams[paramName];
      operation.parameters.push({
        name: paramName,
        in: 'path',
        required: true,
        description: param.description || '',
        schema: convertParamType(param),
      });
    }
  }

  // Convert query parameters
  if (methodData.queryParameters) {
    if (!operation.parameters) operation.parameters = [];
    for (const paramName in methodData.queryParameters) {
      const param = methodData.queryParameters[paramName];
      operation.parameters.push({
        name: paramName,
        in: 'query',
        required: param.required || false,
        description: param.description || '',
        schema: convertParamType(param),
      });
    }
  }

  // Convert URI parameters from method (in addition to path params)
  if (methodData.uriParameters) {
    if (!operation.parameters) operation.parameters = [];
    for (const paramName in methodData.uriParameters) {
      // Skip if already added as path parameter
      const alreadyAdded = operation.parameters.some((p: any) => p.name === paramName && p.in === 'path');
      if (!alreadyAdded) {
        const param = methodData.uriParameters[paramName];
        operation.parameters.push({
          name: paramName,
          in: 'path',
          required: true,
          description: param.description || '',
          schema: convertParamType(param),
        });
      }
    }
  }

  // Convert headers
  if (methodData.headers) {
    if (!operation.parameters) operation.parameters = [];
    for (const headerName in methodData.headers) {
      const header = methodData.headers[headerName];
      operation.parameters.push({
        name: headerName,
        in: 'header',
        required: header.required || false,
        description: header.description || '',
        schema: convertParamType(header),
      });
    }
  }

  // Convert request body
  if (methodData.body) {
    operation.requestBody = {
      content: {},
    };

    for (const contentType in methodData.body) {
      const bodyData = methodData.body[contentType];
      operation.requestBody.content[contentType] = {
        schema: convertBodySchema(bodyData),
      };
    }
  }

  // Convert responses
  if (methodData.responses) {
    for (const statusCode in methodData.responses) {
      const responseData = methodData.responses[statusCode];
      operation.responses[statusCode] = {
        description: responseData.description || `Response ${statusCode}`,
      };

      if (responseData.body) {
        operation.responses[statusCode].content = {};
        for (const contentType in responseData.body) {
          const bodyData = responseData.body[contentType];
          operation.responses[statusCode].content[contentType] = {
            schema: convertBodySchema(bodyData),
          };
        }
      }
    }
  }

  // Default response if none specified
  if (Object.keys(operation.responses).length === 0) {
    operation.responses['200'] = {
      description: 'Success',
    };
  }

  return operation;
}

/**
 * Convert RAML data type to OAS schema
 */
function convertDataType(typeData: any): any {
  if (typeof typeData === 'string') {
    // Check if it's a union type (e.g., "object | object[]")
    if (typeData.includes('|')) {
      const types = typeData.split('|').map(t => t.trim());
      return {
        oneOf: types.map(t => {
          // Handle array types like "object[]"
          if (t.endsWith('[]')) {
            const itemType = t.slice(0, -2).trim();
            return {
              type: 'array',
              items: { type: mapRamlTypeToOasType(itemType) }
            };
          }
          return { type: mapRamlTypeToOasType(t) };
        })
      };
    }
    return { type: mapRamlTypeToOasType(typeData) };
  }

  const schema: any = {};

  if (typeData.type) {
    // Check if type is a union type string
    if (typeof typeData.type === 'string' && typeData.type.includes('|')) {
      const types = typeData.type.split('|').map((t: string) => t.trim());
      schema.oneOf = types.map((t: string) => {
        // Handle array types like "object[]"
        if (t.endsWith('[]')) {
          const itemType = t.slice(0, -2).trim();
          return {
            type: 'array',
            items: { type: mapRamlTypeToOasType(itemType) }
          };
        }
        return { type: mapRamlTypeToOasType(t) };
      });
      
      // Don't set schema.type when using oneOf
    } else {
      const baseType = Array.isArray(typeData.type) ? typeData.type[0] : typeData.type;
      
      // If baseType is an object (expanded library type), convert it recursively
      if (typeof baseType === 'object') {
        return convertDataType(baseType);
      }
      
      schema.type = mapRamlTypeToOasType(baseType);
    }
  } else {
    schema.type = 'object';
  }

  if (typeData.description) schema.description = typeData.description;
  
  if (typeData.properties) {
    schema.properties = {};
    const required: string[] = [];
    
    for (const propName in typeData.properties) {
      const prop = typeData.properties[propName];
      schema.properties[propName] = convertDataType(prop);
      
      if (prop.required) {
        required.push(propName);
      }
    }
    
    if (required.length > 0) {
      schema.required = required;
    }
  }

  if (typeData.items) {
    schema.items = convertDataType(typeData.items);
  }

  if (typeData.enum) schema.enum = typeData.enum;
  if (typeData.pattern) schema.pattern = typeData.pattern;
  if (typeData.minLength !== undefined) schema.minLength = typeData.minLength;
  if (typeData.maxLength !== undefined) schema.maxLength = typeData.maxLength;
  if (typeData.minimum !== undefined) schema.minimum = typeData.minimum;
  if (typeData.maximum !== undefined) schema.maximum = typeData.maximum;
  if (typeData.default !== undefined) schema.default = typeData.default;
  if (typeData.example !== undefined) schema.example = typeData.example;
  if (typeData.examples !== undefined) schema.examples = typeData.examples;

  return schema;
}

/**
 * Convert RAML type to OAS schema
 */
function convertType(type: any): any {
  const schema: any = {
    type: type.type || 'object',
  };

  if (type.description) schema.description = type.description;
  if (type.properties) {
    schema.properties = {};
    for (const prop of type.properties) {
      schema.properties[prop.name] = convertParamType(prop);
    }
  }

  if (type.required) {
    schema.required = type.required;
  }

  return schema;
}

/**
 * Convert RAML parameter type to OAS schema
 */
function convertParamType(param: any): any {
  const schema: any = {
    type: mapRamlTypeToOasType(param.type || 'string'),
  };

  if (param.description) schema.description = param.description;
  if (param.enum) schema.enum = param.enum;
  if (param.pattern) schema.pattern = param.pattern;
  if (param.minLength !== undefined) schema.minLength = param.minLength;
  if (param.maxLength !== undefined) schema.maxLength = param.maxLength;
  if (param.minimum !== undefined) schema.minimum = param.minimum;
  if (param.maximum !== undefined) schema.maximum = param.maximum;
  if (param.default !== undefined) schema.default = param.default;
  if (param.example !== undefined) schema.example = param.example;

  return schema;
}

/**
 * Convert RAML body schema to OAS schema
 */
function convertBodySchema(body: any): any {
  // Debug
  if (process.env.NODE_ENV !== 'production' && body && body.type) {
    console.log('convertBodySchema - body.type:', typeof body.type, JSON.stringify(body.type).substring(0, 100));
  }
  
  // If body is a string (type reference), return simple type
  if (typeof body === 'string') {
    return { type: mapRamlTypeToOasType(body) };
  }

  // If body has a type property
  if (body.type) {
    // If type is a string, convert it
    if (typeof body.type === 'string') {
      return convertDataType(body);
    }
    
    // If type is already an object (expanded library type from resolveLibraries)
    // The structure after expansion is: { type: { type: 'object', properties: {...} } }
    // We need to return the inner type object directly
    if (typeof body.type === 'object') {
      // The body.type is already the schema we want (from library type expansion)
      return convertDataType(body.type);
    }
  }

  // If body has schema property (JSON schema)
  if (body.schema) {
    try {
      if (typeof body.schema === 'string') {
        return JSON.parse(body.schema);
      }
      return body.schema;
    } catch {
      return { type: 'object' };
    }
  }

  // If body has properties (inline type definition)
  if (body.properties) {
    return convertDataType(body);
  }

  // If body has example but no schema
  if (body.example) {
    return { 
      type: 'object',
      example: body.example 
    };
  }

  return { type: 'object' };
}

/**
 * Convert RAML security scheme to OAS security scheme
 */
function convertSecurityScheme(scheme: any): any {
  const type = scheme.type?.toLowerCase();

  switch (type) {
    case 'oauth 2.0':
      return {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: scheme.settings?.authorizationUri || '',
            tokenUrl: scheme.settings?.accessTokenUri || '',
            scopes: scheme.settings?.scopes || {},
          },
        },
      };
    case 'basic authentication':
      return {
        type: 'http',
        scheme: 'basic',
      };
    case 'digest authentication':
      return {
        type: 'http',
        scheme: 'digest',
      };
    case 'pass through':
      return {
        type: 'apiKey',
        in: 'header',
        name: scheme.describedBy?.headers?.[0]?.name || 'Authorization',
      };
    default:
      return {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      };
  }
}

/**
 * Map RAML types to OAS types
 */
function mapRamlTypeToOasType(ramlType: string): string {
  const typeMap: { [key: string]: string } = {
    string: 'string',
    number: 'number',
    integer: 'integer',
    boolean: 'boolean',
    date: 'string',
    'date-only': 'string',
    'time-only': 'string',
    'datetime-only': 'string',
    datetime: 'string',
    file: 'string',
    array: 'array',
    object: 'object',
  };

  return typeMap[ramlType.toLowerCase()] || 'string';
}
