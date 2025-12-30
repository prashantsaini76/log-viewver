import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

interface FileMap {
  [path: string]: string;
}

export interface ConversionResult {
  oas: any;
  yaml: string;
}

// Logger utility
function logToFile(message: string) {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, 'converter-debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] ${message}\n`);
  } catch (e) {
    console.error('Failed to write to log file:', e);
  }
}

function clearLogFile() {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const logFile = path.join(logsDir, 'converter-debug.log');
    fs.writeFileSync(logFile, `=== Conversion started at ${new Date().toISOString()} ===\n\n`);
  } catch (e) {
    console.error('Failed to clear log file:', e);
  }
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
 * Auto-fix common YAML structural issues that cause parsing errors
 * - Removes duplicate keys at the same indentation level
 * - Merges properties that should be nested
 */
function autoFixYamlStructure(content: string): string {
  logToFile('\n>>> Running autoFixYamlStructure');
  
  // Strip Windows line endings first
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  logToFile('First 15 lines of content:');
  content.split('\n').slice(0, 15).forEach((line, idx) => {
    logToFile(`  ${idx + 1}: [${line.search(/\S/)}sp] "${line}"`);
  });
  logToFile('');
  
  const lines = content.split('\n');
  const result: string[] = [];
  
  // Track keys at each indentation level in the current context
  const indentStacks: Map<number, Set<string>> = new Map();
  let currentIndent = -1;
  let duplicatesFound = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip empty lines
    if (!line.trim()) {
      result.push(line);
      // Clear deeper indent levels on empty lines
      indentStacks.forEach((keys, indent) => {
        if (indent > currentIndent) {
          indentStacks.delete(indent);
        }
      });
      continue;
    }
    
    // Get indentation level
    const indent = line.search(/\S/);
    if (indent === -1) {
      result.push(line);
      continue;
    }
    
    // Clear indent stacks for levels deeper than current (NOT equal)
    if (indent < currentIndent) {
      indentStacks.forEach((keys, stackIndent) => {
        if (stackIndent > indent) {
          indentStacks.delete(stackIndent);
        }
      });
    }
    currentIndent = indent;
    
    // Check if this is a key-value line
    const keyMatch = line.match(/^(\s*)([^:\s#]+):\s*(.*)$/);
    if (keyMatch) {
      const [, , key, value] = keyMatch;
      
      logToFile(`  Line ${i + 1}: indent=${indent}, key="${key}"`)
      
      // Initialize set for this indent level if not exists
      if (!indentStacks.has(indent)) {
        indentStacks.set(indent, new Set());
        logToFile(`    Created new key set for indent ${indent}`);
      }
      
      const keysAtLevel = indentStacks.get(indent)!;
      
      logToFile(`    Keys at indent ${indent}: [${Array.from(keysAtLevel).join(', ')}]`);
      
      // Check for duplicate
      if (keysAtLevel.has(key)) {
        duplicatesFound++;
        logToFile(`⚠️ Duplicate key detected: "${key}" at indent ${indent} (line ${i + 1})`);
        logToFile(`   Skipping: ${line}`);
        
        // Comment out the duplicate line instead of removing it
        result.push(`${' '.repeat(indent)}# DUPLICATE REMOVED: ${key}`);
        continue;
      }
      
      keysAtLevel.add(key);
      logToFile(`    Added "${key}" to indent ${indent}`);
    }
    
    result.push(line);
  }
  
  logToFile(`>>> autoFixYamlStructure complete: ${duplicatesFound} duplicates removed\n`);
  
  return result.join('\n');
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
    // Clear and initialize log file
    clearLogFile();
    logToFile('======================');
    logToFile('Starting RAML to OAS conversion');
    logToFile(`Main RAML file: ${mainRamlFile}`);
    logToFile(`Total files in archive: ${Object.keys(files).length}`);
    logToFile('======================\n');
    
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
    let fixedContent = autoFixYamlIndentation(libraryResolvedContent);
    
    // Auto-fix structural issues (duplicate keys, etc.)
    fixedContent = autoFixYamlStructure(fixedContent);

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
          
          // Auto-fix common YAML structural issues before parsing
          libContent = autoFixYamlStructure(libContent);
          
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
            
            let errorContext = '';
            
            // Add more context about the error
            if (e instanceof Error) {
              console.error('YAML Parse Error:', e.message);
              console.error('Error name:', e.name);
              
              // Parse the error message to find line number
              const lineMatch = e.message.match(/\((\d+):(\d+)\)/);
              const errorLineNum = lineMatch ? parseInt(lineMatch[1]) - 1 : -1;
              
              // Show a snippet of the library content that failed to parse
              const lines = libContent.split('\n');
              
              if (errorLineNum >= 0) {
                // Show context around the error line
                const start = Math.max(0, errorLineNum - 10);
                const end = Math.min(lines.length, errorLineNum + 5);
                
                console.error(`\nLibrary content around error (lines ${start + 1}-${end + 1}):`);
                lines.slice(start, end).forEach((line, idx) => {
                  const lineNum = start + idx + 1;
                  const isErrorLine = (start + idx === errorLineNum);
                  const marker = isErrorLine ? ' <-- ERROR' : '';
                  const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
                  console.error(`  ${lineNum.toString().padStart(3)} [${spaces.toString().padStart(2)}sp] | ${line}${marker}`);
                });
              } else {
                console.error(`\nLibrary content (first 20 lines):`);
                lines.slice(0, 20).forEach((line, idx) => {
                  const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
                  console.error(`  ${(idx + 1).toString().padStart(3)} [${spaces.toString().padStart(2)}sp] | ${line}`);
                });
              }
              
              if (lines.length > 20) {
                console.error(`  ... and ${lines.length - 20} more lines`);
              }
              
              // Show FULL content with indentation markers
              console.error(`\n\n=== FULL LIBRARY CONTENT (${lines.length} lines) ===`);
              logToFile(`\n\n=== FULL LIBRARY CONTENT FOR ${libName} (${lines.length} lines) ===`);
              lines.forEach((line, idx) => {
                const lineNum = idx + 1;
                const isErrorLine = (idx === errorLineNum);
                const marker = isErrorLine ? ' <-- ERROR' : '';
                const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
                const logLine = `${lineNum.toString().padStart(3)} [${spaces.toString().padStart(2)}sp] | ${line}${marker}`;
                console.error(logLine);
                logToFile(logLine);
              });
              console.error('=== END FULL LIBRARY CONTENT ===\n');
              logToFile('=== END FULL LIBRARY CONTENT ===\n');
              
              // Also return the problematic content in the error message for easier debugging
              const contextLines = errorLineNum >= 0 
                ? lines.slice(Math.max(0, errorLineNum - 5), Math.min(lines.length, errorLineNum + 5))
                : lines.slice(0, 10);
              errorContext = '\nContext:\n' + contextLines.map((line, idx) => {
                const actualLineNum = errorLineNum >= 0 ? Math.max(0, errorLineNum - 5) + idx + 1 : idx + 1;
                const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
                return `${actualLineNum} [${spaces}sp] | ${line}`;
              }).join('\n');
              
              if (e.message.includes('unknown tag')) {
                console.error('\n💡 Tip: This library may contain unresolved !include directives or RAML-specific syntax.');
              }
              if (libContent.includes('uses:')) {
                console.error('\n💡 Tip: This library has a "uses:" block - it may be importing other libraries that need to be resolved first.');
              }
              
              // Save the problematic library content to a file for manual inspection/fixing
              try {
                const logsDir = path.join(process.cwd(), 'logs');
                if (!fs.existsSync(logsDir)) {
                  fs.mkdirSync(logsDir, { recursive: true });
                }
                
                // Extract just the filename from the library path
                const fileName = libPath.split('/').pop() || `${libName}.raml`;
                const outputPath = path.join(logsDir, fileName);
                
                fs.writeFileSync(outputPath, libContent, 'utf-8');
                console.error(`\n📝 Saved problematic library content to: logs/${fileName}`);
                console.error(`   You can manually fix the indentation in this file.`);
                logToFile(`\n📝 Saved problematic library content to: logs/${fileName}`);
              } catch (saveError) {
                console.error('Failed to save library content to file:', saveError);
              }
            }
            
            // Create a more informative error message that includes the context
            throw new Error(`${errorMsg}\nOriginal error: ${e instanceof Error ? e.message : String(e)}${errorContext}`);
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
      logToFile(`\n>>> Processing Pattern 1: key: !include`);
      logToFile(`    Key: "${key}"`);
      logToFile(`    Include path: ${includePath.trim()}`);
      logToFile(`    Base indent: "${indent}" (${indent.length} chars)`);
      logToFile(`    Additional indent: "${additionalIndent}" (${additionalIndent.length} chars)`);
      logToFile(`    Base indent of included file: ${baseIndentOfIncludedFile}`);
      logToFile(`    First 3 lines of included file:`);
      contentLines.slice(0, 3).forEach((line, idx) => {
        logToFile(`      ${idx + 1}: [${line.search(/\S/)}sp] "${line}"`);
      });
      
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
          
          // Debug: Log if we're about to add a line with suspicious indentation
          if (newIndent.length === 0) {
            const warningMsg = [
              `⚠️ WARNING: About to add line with 0 spaces at result line ${result.length + 1}`,
              `   Content: "${contentLine.trim()}"`,
              `   Include key: "${key}", path: ${includePath.trim()}`,
              `   Base indent: "${indent}" (${indent.length} chars)`,
              `   Additional indent: "${additionalIndent}" (${additionalIndent.length} chars)`,
              `   Relative indent: ${relativeIndent}`,
              `   Line from included file had ${lineIndent} spaces`,
              `   Base indent of included file: ${baseIndentOfIncludedFile}`,
              `   Result has ${result.length} lines so far`,
              `   Previous 5 lines:`
            ].join('\n');
            
            console.error(warningMsg);
            logToFile(warningMsg);
            
            result.slice(-5).forEach((line, idx) => {
              const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
              const lineMsg = `     ${result.length - 4 + idx}: [${spaces}sp] ${line}`;
              console.error(lineMsg);
              logToFile(lineMsg);
            });
            
            // FORCE a minimum indentation to prevent YAML errors
            const fixMsg = `   🔧 FIXING: Forcing minimum 2 spaces indentation`;
            console.error(fixMsg);
            logToFile(fixMsg);
          }
          
          // Safety fix: Never allow 0-indent lines deep in the file
          const finalIndent = newIndent.length === 0 && result.length > 5 ? '  ' : newIndent;
          
          // Clean the content: remove invalid YAML syntax like <tagname>
          let cleanedContent = contentLine.trim();
          
          // Remove <...> tags that are not valid YAML (like <status>, <200>, etc.)
          const tagMatch = cleanedContent.match(/^([^:]+:\s*)(.+?)(\s*<[^>]+>)(.*)$/);
          if (tagMatch) {
            const [, keyPart, valuePart, tagPart, rest] = tagMatch;
            const warningMsg = `⚠️ Removing invalid YAML tag from line: "${cleanedContent}"`;
            console.warn(warningMsg);
            logToFile(warningMsg);
            cleanedContent = keyPart + valuePart + rest;
            logToFile(`   Cleaned to: "${cleanedContent}"`);
          }
          
          result.push(finalIndent + cleanedContent);
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
          
          // Debug: Log if we're about to add a line with suspicious indentation
          if (newIndent.length === 0) {
            const warningMsg = [
              `⚠️ WARNING: About to add line with 0 spaces at result line ${result.length + 1}`,
              `   Content: "${contentLine.trim()}"`,
              `   Include path: ${includePath.trim()}`,
              `   Base indent: "${indent}" (${indent.length} chars)`,
              `   Relative indent: ${relativeIndent}`,
              `   Line from included file had ${lineIndent} spaces`,
              `   Base indent of included file: ${baseIndentOfIncludedFile}`,
              `   Result has ${result.length} lines so far`,
              `   Previous 5 lines:`
            ].join('\n');
            
            console.error(warningMsg);
            logToFile(warningMsg);
            
            result.slice(-5).forEach((line, idx) => {
              const spaces = line.search(/\S/) === -1 ? 0 : line.search(/\S/);
              const lineMsg = `     ${result.length - 4 + idx}: [${spaces}sp] ${line}`;
              console.error(lineMsg);
              logToFile(lineMsg);
            });
            
            // FORCE a minimum indentation to prevent YAML errors
            const fixMsg = `   🔧 FIXING: Forcing minimum 2 spaces indentation`;
            console.error(fixMsg);
            logToFile(fixMsg);
          }
          
          // Safety fix: Never allow 0-indent lines deep in the file
          const finalIndent = newIndent.length === 0 && result.length > 5 ? '  ' : newIndent;
          
          result.push(finalIndent + contentLine.trim());
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
/**
 * Format the info description with structured metadata
 */
function formatInfoDescription(description: string): string {
  const formatted = `- **API Type:** internal
- **API Risk Classification:** LOW
- **API Owner (business):** bp-tcv-ad@barclays.com
- **API Owner (technical):** bp-tcv-ad@barclays.com
- **Overview:** ${description || 'API description'}`;
  
  return formatted;
}

/**
 * Convert RAML specification to OpenAPI Specification
 */
function convertRamlToOasSpec(ramlData: any): any {
  // Basic OAS 3.0 structure
  const oas: any = {
    openapi: '3.0.0',
    info: {
      title: ramlData.title || 'API',
      version: ramlData.version || '1.0.0',
      description: formatInfoDescription(ramlData.description || ''),
      contact: {
        name: 'TODO',
        url: 'https://TODO',
        email: 'TODO@barclays.com'
      }
    },
    servers: [],
    paths: {},
    components: {
      schemas: {},
      securitySchemes: {
        oauth_2: {
          type: 'oauth2',
          description: 'OAuth 2.0 authentication',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://example.com/oauth/authorize',
              tokenUrl: 'https://example.com/oauth/token',
              scopes: {
                'read': 'Read access',
                'write': 'Write access'
              }
            }
          }
        }
      },
      headers: {
        'Cache-Control': {
          description: '',
          example: 'no-cache, no-store, must-revalidate',
          schema: {
            type: 'string',
            default: 'no-cache, no-store, must-revalidate',
            deprecated: false,
            nullable: false,
            minLength: 8,
            maxLength: 35,
            pattern: '^no-cache, no-store, must-revalidate$'
          }
        },
        'Location': {
          description: 'Location of newly created resource',
          example: '/resourceName/12345',
          schema: {
            type: 'string',
            deprecated: false,
            nullable: false,
            minLength: 1,
            maxLength: 255,
            pattern: '^[A-Za-z0-9\\/_-]{1,255}$'
          }
        }
      }
    },
  };

  // Convert base URI to servers
  if (ramlData.baseUri) {
    oas.servers.push({
      url: ramlData.baseUri.replace(/{version}/g, ramlData.version || '1.0.0'),
      description: 'TODO'
    });
  }

  // Convert protocols
  if (ramlData.protocols && ramlData.protocols.length > 0) {
    const protocol = ramlData.protocols[0].toLowerCase();
    if (!ramlData.baseUri) {
      oas.servers.push({ 
        url: `${protocol}://example.com`,
        description: 'TODO'
      });
    }
  }
  
  // If still no servers, add default template
  if (oas.servers.length === 0) {
    oas.servers.push({
      url: 'https://{server}/{contextRoot}/{version}',
      description: 'TODO',
      variables: {
        server: {
          default: 'api.example.com',
          description: 'Server hostname'
        },
        contextRoot: {
          default: 'api',
          description: 'API context root'
        },
        version: {
          default: ramlData.version || 'v1',
          description: 'API version'
        }
      }
    });
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
  
  // Add path-level summary and description if available
  if (resource.displayName) {
    paths[fullPath].summary = resource.displayName;
  } else {
    // Generate a default summary from the path
    const pathName = fullPath.split('/').filter(p => p && !p.startsWith('{')).pop() || 'Resource';
    paths[fullPath].summary = pathName.charAt(0).toUpperCase() + pathName.slice(1);
  }
  
  if (resource.description) {
    paths[fullPath].description = resource.description;
  } else {
    // Add default description
    paths[fullPath].description = `Operations for ${fullPath}`;
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
      paths[fullPath][method] = convertMethod(resource[method], method, fullPath, traits, pathParams);
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
function convertMethod(methodData: any, methodName?: string, resourcePath?: string, traits?: any, pathParams?: any): any {
  // Apply traits if the method uses them (is: [trait1, trait2])
  if (methodData.is && Array.isArray(methodData.is) && traits) {
    for (const traitName of methodData.is) {
      if (traits[traitName]) {
        // Merge trait properties into method
        methodData = { ...traits[traitName], ...methodData };
      }
    }
  }

  // Generate operationId from method name and resource path
  let operationId = '';
  if (methodName && resourcePath) {
    // Convert path like /users/{id} to getUsersById
    const pathParts = resourcePath
      .split('/')
      .filter(part => part && !part.startsWith('{'))
      .map(part => part.charAt(0).toUpperCase() + part.slice(1));
    
    // Add parameter names from path like {id} -> ById
    const paramParts = resourcePath
      .match(/\{([^}]+)\}/g)
      ?.map(param => {
        const paramName = param.replace(/[{}]/g, '');
        return 'By' + paramName.charAt(0).toUpperCase() + paramName.slice(1);
      }) || [];
    
    operationId = methodName + pathParts.join('') + paramParts.join('');
  }

  const operation: any = {
    summary: methodData.displayName || methodData.description || (methodName ? methodName.toUpperCase() : 'Operation'),
    description: methodData.description || '',
    responses: {},
  };

  // Add operationId if generated
  if (operationId) {
    operation.operationId = operationId;
  };

  // Add path parameters first
  if (pathParams && Object.keys(pathParams).length > 0) {
    operation.parameters = [];
    for (const paramName in pathParams) {
      const param = pathParams[paramName];
      const schema = convertParamType(param);
      operation.parameters.push({
        name: paramName,
        in: 'path',
        required: true,
        description: param.description || '',
        schema: schema,
        example: param.example !== undefined ? param.example : generateDefaultExample(paramName, schema.type, 'path')
      });
    }
  }

  // Convert query parameters
  if (methodData.queryParameters) {
    if (!operation.parameters) operation.parameters = [];
    for (const paramName in methodData.queryParameters) {
      const param = methodData.queryParameters[paramName];
      const schema = convertParamType(param);
      operation.parameters.push({
        name: paramName,
        in: 'query',
        required: param.required || false,
        description: param.description || '',
        schema: schema,
        example: param.example !== undefined ? param.example : generateDefaultExample(paramName, schema.type, 'query')
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
        const schema = convertParamType(param);
        operation.parameters.push({
          name: paramName,
          in: 'path',
          required: true,
          description: param.description || '',
          schema: schema,
          example: param.example !== undefined ? param.example : generateDefaultExample(paramName, schema.type, 'path')
        });
      }
    }
  }

  // Convert headers
  if (methodData.headers) {
    if (!operation.parameters) operation.parameters = [];
    for (const headerName in methodData.headers) {
      const header = methodData.headers[headerName];
      const schema = convertParamType(header);
      operation.parameters.push({
        name: headerName,
        in: 'header',
        required: header.required || false,
        description: header.description || '',
        schema: schema,
        example: header.example !== undefined ? header.example : generateDefaultExample(headerName, schema.type, 'header')
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
      const mediaTypeObject: any = {
        schema: convertBodySchema(bodyData, false), // false = don't include example in schema
      };
      
      // Add examples at media type level (not in schema)
      if (bodyData.example !== undefined) {
        mediaTypeObject.examples = {
          example1: {
            value: bodyData.example
          }
        };
      }
      
      operation.requestBody.content[contentType] = mediaTypeObject;
    }
  }

  // Convert responses
  if (methodData.responses) {
    for (const statusCode in methodData.responses) {
      const responseData = methodData.responses[statusCode];
      operation.responses[statusCode] = {
        description: responseData.description || `Response ${statusCode}`,
        headers: {
          'Cache-Control': {
            $ref: '#/components/headers/Cache-Control'
          },
          'Location': {
            $ref: '#/components/headers/Location'
          }
        }
      };

      if (responseData.body) {
        operation.responses[statusCode].content = {};
        for (const contentType in responseData.body) {
          const bodyData = responseData.body[contentType];
          const mediaTypeObject: any = {
            schema: convertBodySchema(bodyData, false), // false = don't include example in schema
          };
          
          // Add examples at media type level (not in schema)
          if (bodyData.example !== undefined) {
            mediaTypeObject.examples = {
              example1: {
                value: bodyData.example
              }
            };
          }
          
          operation.responses[statusCode].content[contentType] = mediaTypeObject;
        }
      }
    }
  }

  // Default response if none specified
  if (Object.keys(operation.responses).length === 0) {
    operation.responses['200'] = {
      description: 'Success',
      headers: {
        'Cache-Control': {
          $ref: '#/components/headers/Cache-Control'
        },
        'Location': {
          $ref: '#/components/headers/Location'
        }
      }
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
            const mappedItemType = mapRamlTypeToOasType(itemType);
            const items: any = { 
              type: mappedItemType, 
              deprecated: false, 
              nullable: true 
            };
            // Add string properties to items
            if (mappedItemType === 'string') {
              items.minLength = 0;
              items.maxLength = 255;
              items.pattern = '^.*$';
            }
            // Add additionalProperties to object items
            if (mappedItemType === 'object') {
              items.additionalProperties = false;
            }
            return {
              type: 'array',
              items: items,
              deprecated: false,
              nullable: true,
              minItems: 0,
              maxItems: 100
            };
          }
          const mappedType = mapRamlTypeToOasType(t);
          const schema: any = { 
            type: mappedType,
            deprecated: false,
            nullable: true
          };
          // Add string defaults
          if (mappedType === 'string') {
            schema.minLength = 0;
            schema.maxLength = 255;
            schema.pattern = '^.*$';  // Default pattern to match anything
          }
          // Add additionalProperties for objects
          if (mappedType === 'object') {
            schema.additionalProperties = false;
          }
          return schema;
        })
      };
    }
    const mappedType = mapRamlTypeToOasType(typeData);
    const schema: any = { 
      type: mappedType,
      deprecated: false,
      nullable: true
    };
    // Add string defaults
    if (mappedType === 'string') {
      schema.minLength = 0;
      schema.maxLength = 255;
      schema.pattern = '^.*$';  // Default pattern to match anything
    }
    // Add array defaults
    if (mappedType === 'array') {
      schema.minItems = 0;
      schema.maxItems = 100;
      schema.items = { 
        type: 'string', 
        deprecated: false, 
        nullable: true,
        minLength: 0,
        maxLength: 255,
        pattern: '^.*$'
      };
    }
    // Add additionalProperties for objects
    if (mappedType === 'object') {
      schema.additionalProperties = false;
    }
    return schema;
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
          const mappedItemType = mapRamlTypeToOasType(itemType);
          const items: any = { 
            type: mappedItemType, 
            deprecated: false, 
            nullable: true 
          };
          // Add string properties to items
          if (mappedItemType === 'string') {
            items.minLength = 0;
            items.maxLength = 255;
            items.pattern = '^.*$';
          }
          // Add additionalProperties to object items
          if (mappedItemType === 'object') {
            items.additionalProperties = false;
          }
          return {
            type: 'array',
            items: items,
            deprecated: false,
            nullable: true,
            minItems: 0,
            maxItems: 100
          };
        }
        const mappedType = mapRamlTypeToOasType(t);
        const unionSchema: any = { 
          type: mappedType,
          deprecated: false,
          nullable: true
        };
        // Add string defaults
        if (mappedType === 'string') {
          unionSchema.minLength = 0;
          unionSchema.maxLength = 255;
          unionSchema.pattern = '^.*$';  // Default pattern to match anything
        }
        // Add additionalProperties for objects
        if (mappedType === 'object') {
          unionSchema.additionalProperties = false;
        }
        return unionSchema;
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
  
  // Add deprecated property (default to false)
  schema.deprecated = typeData.deprecated || false;
  
  // Add nullable property based on required field (if not required, it's nullable)
  schema.nullable = typeData.required === false || typeData.required === undefined;
  
  // Add additionalProperties: false for object types
  if (schema.type === 'object') {
    schema.additionalProperties = false;
  }
  
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
  
  // String type enhancements
  if (schema.type === 'string') {
    schema.minLength = typeData.minLength !== undefined ? typeData.minLength : 0;
    schema.maxLength = typeData.maxLength !== undefined ? typeData.maxLength : 255;
    
    // Add pattern - use RAML pattern if present, otherwise default to match anything
    if (typeData.pattern) {
      schema.pattern = typeData.pattern;
    } else if (!typeData.enum) {
      // Only add default pattern if there's no enum (enum takes precedence)
      schema.pattern = '^.*$';
    }
  } else {
    if (typeData.minLength !== undefined) schema.minLength = typeData.minLength;
    if (typeData.maxLength !== undefined) schema.maxLength = typeData.maxLength;
  }
  
  // Array type enhancements - ONLY add to arrays
  if (schema.type === 'array') {
    schema.minItems = typeData.minItems !== undefined ? typeData.minItems : 0;
    schema.maxItems = typeData.maxItems !== undefined ? typeData.maxItems : 100;
    // Ensure items property exists
    if (!schema.items) {
      schema.items = { type: 'string', deprecated: false, nullable: true };
    }
  }
  
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
 * Generate a default example value based on parameter type and name
 */
function generateDefaultExample(paramName: string, paramType: string, paramIn: string): any {
  // Specific examples based on common parameter names
  const lowerName = paramName.toLowerCase();
  
  if (paramIn === 'header') {
    if (lowerName === 'authorization') return 'Bearer <token>';
    if (lowerName === 'content-type') return 'application/json';
    if (lowerName.includes('token')) return '<token>';
    return 'header-value';
  }
  
  if (paramIn === 'path') {
    if (lowerName.includes('id')) return 'id123';
    if (lowerName.includes('user')) return 'user123';
    if (lowerName.includes('order')) return 'order123';
    return 'value';
  }
  
  // Generate based on type
  switch (paramType) {
    case 'string':
      if (lowerName.includes('email')) return 'user@example.com';
      if (lowerName.includes('name')) return 'John Doe';
      if (lowerName.includes('page')) return '1';
      if (lowerName.includes('size') || lowerName.includes('limit')) return '10';
      return 'string-value';
    case 'integer':
    case 'number':
      if (lowerName.includes('page')) return 1;
      if (lowerName.includes('size') || lowerName.includes('limit')) return 10;
      return 0;
    case 'boolean':
      return true;
    case 'array':
      return [];
    default:
      return 'value';
  }
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
function convertBodySchema(body: any, includeExampleInSchema: boolean = true): any {
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
    let schema: any;
    
    // If type is a string, convert it
    if (typeof body.type === 'string') {
      schema = convertDataType(body);
    } else if (typeof body.type === 'object') {
      // If type is already an object (expanded library type from resolveLibraries)
      // The structure after expansion is: { type: { type: 'object', properties: {...} } }
      // We need to return the inner type object directly
      schema = convertDataType(body.type);
    }
    
    // Add example if present in body AND includeExampleInSchema is true
    // (for external example files like !include examples/user.json)
    if (body.example !== undefined && schema && includeExampleInSchema) {
      schema.example = body.example;
    }
    
    if (schema) return schema;
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
    const schema = convertDataType(body);
    // Add example if present AND includeExampleInSchema is true
    if (body.example !== undefined && includeExampleInSchema) {
      schema.example = body.example;
    }
    return schema;
  }

  // If body has example but no schema
  if (body.example && includeExampleInSchema) {
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

/**
 * Flatten a RAML project with multiple files into a single RAML file
 * by resolving all !include directives and library references
 */
export async function flattenRaml(
  files: { [key: string]: string },
  mainRamlFile: string
): Promise<string> {
  try {
    // Get the main RAML content
    let mainContent = files[mainRamlFile];
    
    if (!mainContent) {
      throw new Error(`Main RAML file not found: ${mainRamlFile}`);
    }
    
    // Resolve all includes
    mainContent = resolveIncludes(mainContent, files, mainRamlFile);
    
    // Fix YAML structure issues
    mainContent = autoFixYamlStructure(mainContent);
    
    // Parse the RAML
    const ramlObj = yaml.load(mainContent) as any;
    
    // If there are library references, inline them
    if (ramlObj.uses) {
      const libraries = ramlObj.uses;
      
      // Inline all library types into the main types section
      if (!ramlObj.types) {
        ramlObj.types = {};
      }
      
      // Process each library
      for (const [libName, libPath] of Object.entries(libraries)) {
        if (typeof libPath !== 'string') continue;
        
        // Find the library file path
        const libFilePath = libPath.replace(/^\//, '');
        let libraryContent = files[libFilePath];
        
        if (!libraryContent) {
          // Try to find relative to main file
          const mainDir = mainRamlFile.substring(0, mainRamlFile.lastIndexOf('/') + 1);
          const relativePath = mainDir + libFilePath;
          libraryContent = files[relativePath];
        }
        
        if (libraryContent) {
          // Resolve includes in the library
          libraryContent = resolveIncludes(libraryContent, files, libFilePath);
          libraryContent = autoFixYamlStructure(libraryContent);
          const libraryObj = yaml.load(libraryContent) as any;
          
          // Inline library types with library name prefix
          if (libraryObj.types) {
            for (const [typeName, typeDef] of Object.entries(libraryObj.types)) {
              const fullTypeName = `${libName}.${typeName}`;
              ramlObj.types[fullTypeName] = typeDef;
            }
          }
          
          // Inline library traits
          if (libraryObj.traits) {
            if (!ramlObj.traits) {
              ramlObj.traits = {};
            }
            for (const [traitName, traitDef] of Object.entries(libraryObj.traits)) {
              const fullTraitName = `${libName}.${traitName}`;
              ramlObj.traits[fullTraitName] = traitDef;
            }
          }
        }
      }
      
      // Remove the uses block after inlining
      delete ramlObj.uses;
    }
    
    // Inline all trait definitions that were in separate files
    if (ramlObj.traits) {
      const inlinedTraits: any = {};
      for (const [traitName, traitDef] of Object.entries(ramlObj.traits)) {
        inlinedTraits[traitName] = traitDef;
      }
      ramlObj.traits = inlinedTraits;
    }
    
    // Convert back to YAML
    const flattenedYaml = yaml.dump(ramlObj, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    
    // Add RAML version header if not present
    const ramlVersion = ramlObj.title ? '#%RAML 1.0\n' : '#%RAML 0.8\n';
    const finalRaml = flattenedYaml.startsWith('#%RAML') 
      ? flattenedYaml 
      : ramlVersion + flattenedYaml;
    
    return finalRaml;
  } catch (error: any) {
    throw new Error(`Failed to flatten RAML: ${error.message}`);
  }
}

/**
 * Flatten an OpenAPI specification with multiple files into a single file
 * by resolving all $ref references to external files
 */
export async function flattenOas(
  files: { [key: string]: string },
  mainOasFile: string
): Promise<string> {
  try {
    // Get the main OAS content
    let mainContent = files[mainOasFile];
    
    if (!mainContent) {
      throw new Error(`Main OpenAPI file not found: ${mainOasFile}`);
    }

    // Parse the OAS (could be JSON or YAML)
    let oasObj: any;
    if (mainOasFile.endsWith('.json')) {
      oasObj = JSON.parse(mainContent);
    } else {
      oasObj = yaml.load(mainContent) as any;
    }

    // Recursively resolve all $ref references
    const resolveRefs = (obj: any, currentPath: string): any => {
      if (obj === null || obj === undefined) {
        return obj;
      }

      if (Array.isArray(obj)) {
        return obj.map(item => resolveRefs(item, currentPath));
      }

      if (typeof obj === 'object') {
        // Check if this object has a $ref
        if (obj.$ref && typeof obj.$ref === 'string') {
          const ref = obj.$ref;
          
          // Handle external file references (not internal #/components/... refs)
          if (!ref.startsWith('#/')) {
            // Split reference into file path and internal path
            const [filePath, internalPath] = ref.split('#');
            
            if (filePath) {
              // Resolve the file path relative to current file
              const currentDir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
              let resolvedPath = filePath.startsWith('./') || filePath.startsWith('../')
                ? currentDir + filePath
                : filePath;
              
              // Normalize path (remove ./ and ../)
              const parts = resolvedPath.split('/');
              const normalized: string[] = [];
              for (const part of parts) {
                if (part === '..') {
                  normalized.pop();
                } else if (part !== '.' && part !== '') {
                  normalized.push(part);
                }
              }
              resolvedPath = normalized.join('/');

              // Load the referenced file
              let refContent = files[resolvedPath];
              if (!refContent) {
                console.warn(`Referenced file not found: ${resolvedPath}`);
                return obj; // Return original ref if file not found
              }

              // Parse the referenced file
              let refObj: any;
              if (resolvedPath.endsWith('.json')) {
                refObj = JSON.parse(refContent);
              } else {
                refObj = yaml.load(refContent) as any;
              }

              // If there's an internal path (e.g., #/components/schemas/User), navigate to it
              if (internalPath) {
                const pathParts = internalPath.split('/').filter((p: string) => p);
                let target = refObj;
                for (const part of pathParts) {
                  target = target?.[part];
                }
                refObj = target;
              }

              // Recursively resolve refs in the loaded content
              return resolveRefs(refObj, resolvedPath);
            }
          }
          
          // For internal refs (#/components/...), keep them as-is
          return obj;
        }

        // Recursively process all properties
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
          result[key] = resolveRefs(value, currentPath);
        }
        return result;
      }

      return obj;
    };

    // Resolve all external references
    const flattenedObj = resolveRefs(oasObj, mainOasFile);

    // Convert back to YAML
    const flattenedYaml = yaml.dump(flattenedObj, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    return flattenedYaml;
  } catch (error: any) {
    throw new Error(`Failed to flatten OpenAPI: ${error.message}`);
  }
}

/**
 * Validate a payload against OpenAPI specification
 */
export async function validatePayload(
  files: { [key: string]: string },
  mainOasFile: string,
  options: {
    payload: any;
    path: string;
    method: string;
    type: 'request' | 'response';
    headers?: any;
  }
): Promise<{ valid: boolean; errors: any[] }> {
  try {
    console.log('Starting validation...');
    console.log('Files:', Object.keys(files));
    console.log('Main file:', mainOasFile);
    console.log('Options:', options);
    
    let { payload, path, method, type, headers } = options;
    const errors: any[] = [];

    // Extract query parameters from path if present (e.g., /orders?id=3&name=GBSS)
    let queryParams: any = {};
    let cleanPath = path;
    
    if (path.includes('?')) {
      const [pathPart, queryString] = path.split('?');
      cleanPath = pathPart;
      
      // Parse query string
      const queryPairs = queryString.split('&');
      for (const pair of queryPairs) {
        const [key, value] = pair.split('=');
        if (key) {
          queryParams[decodeURIComponent(key)] = decodeURIComponent(value || '');
        }
      }
      console.log('Extracted query parameters:', queryParams);
    }

    // Get the main OAS content
    let mainContent = files[mainOasFile];
    
    if (!mainContent) {
      throw new Error(`Main OpenAPI file not found: ${mainOasFile}`);
    }

    console.log('Parsing OAS...');
    // Parse the OAS (could be JSON or YAML)
    let oasObj: any;
    if (mainOasFile.endsWith('.json')) {
      oasObj = JSON.parse(mainContent);
    } else {
      oasObj = yaml.load(mainContent) as any;
    }

    console.log('OAS paths:', Object.keys(oasObj.paths || {}));

    // DON'T resolve all refs upfront - it can cause infinite loops
    // Instead, resolve refs only when needed for the specific path

    // Find the path in OAS
    const paths = oasObj.paths || {};
    let pathDef = paths[cleanPath];
    let pathParams: any = {};
    let matchedPathTemplate = cleanPath;

    console.log('Looking for path:', cleanPath);
    console.log('Found pathDef:', pathDef ? 'yes' : 'no');

    // If exact path not found, try to match path parameters
    if (!pathDef) {
      const pathKeys = Object.keys(paths);
      for (const key of pathKeys) {
        // Convert OAS path template to regex (e.g., /users/{id} -> /users/([^/]+))
        const paramNames: string[] = [];
        const pattern = key.replace(/\{([^}]+)\}/g, (match, paramName) => {
          paramNames.push(paramName);
          return '([^/?]+)';
        });
        const regex = new RegExp(`^${pattern}$`);
        const matches = cleanPath.match(regex);
        
        if (matches) {
          pathDef = paths[key];
          matchedPathTemplate = key;
          
          // Extract path parameter values
          for (let i = 0; i < paramNames.length; i++) {
            pathParams[paramNames[i]] = matches[i + 1];
          }
          console.log('Matched path template:', key);
          console.log('Extracted path parameters:', pathParams);
          break;
        }
      }
    }

    if (!pathDef) {
      errors.push({
        field: 'path',
        message: `Path '${cleanPath}' not found in OpenAPI specification. Available paths: ${Object.keys(paths).join(', ')}`,
        value: cleanPath
      });
      return { valid: false, errors };
    }

    // Resolve path-level $ref if present
    if (pathDef.$ref) {
      console.log('Resolving path $ref:', pathDef.$ref);
      pathDef = resolveRef(pathDef.$ref, oasObj, files, mainOasFile);
      console.log('Resolved pathDef methods:', Object.keys(pathDef));
    }

    // Get the method definition
    const methodDef = pathDef[method.toLowerCase()];
    console.log('Looking for method:', method.toLowerCase());
    console.log('Found methodDef:', methodDef ? 'yes' : 'no');
    
    if (!methodDef) {
      const availableMethods = Object.keys(pathDef).filter(k => 
        ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(k.toLowerCase())
      );
      errors.push({
        field: 'method',
        message: `Method '${method}' not defined for path '${path}'. Available methods: ${availableMethods.join(', ')}`,
        value: method,
        expected: availableMethods
      });
      return { valid: false, errors };
    }

    // Get the schema to validate against
    let schema: any;
    console.log('Getting schema for type:', type);
    
    if (type === 'request') {
      // Validate request body
      let requestBody = methodDef.requestBody;
      console.log('RequestBody:', requestBody ? 'found' : 'not found');
      
      // For GET, HEAD, DELETE methods, request body is typically not used
      // If no request body is defined, validate parameters instead or skip validation
      if (!requestBody) {
        const methodUpper = method.toUpperCase();
        
        // For methods that typically don't have bodies, validate parameters if provided
        if (['GET', 'HEAD', 'DELETE'].includes(methodUpper)) {
          // Check if there are parameters defined
          const parameters = methodDef.parameters || pathDef.parameters || [];
          console.log(`Found ${parameters.length} parameters for ${method} ${cleanPath}`);
          
          if (parameters.length === 0 && !headers) {
            // No parameters, no headers, and no request body - nothing to validate
            console.log(`No request body or parameters defined for ${method} ${cleanPath}. Skipping validation.`);
            return { valid: true, errors: [] };
          }
          
          // Merge extracted query params, path params, and any payload provided
          const allParams = {
            ...queryParams,
            ...pathParams,
            ...(payload && typeof payload === 'object' ? payload : {})
          };
          
          // Only include headers if they were explicitly provided for validation
          if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
            Object.assign(allParams, headers);
          }
          
          if (Object.keys(allParams).length > 0 || parameters.length > 0) {
            console.log('Validating parameters with merged values:', allParams);
            validateParameters(parameters, allParams, errors, oasObj, files, mainOasFile);
            return { valid: errors.length === 0, errors };
          }
          
          // No parameters provided - just check if endpoint exists
          console.log(`${method} request with ${parameters.length} parameters defined. No parameter values to validate.`);
          return { valid: true, errors: [] };
        }
        
        // For POST, PUT, PATCH - request body is expected
        errors.push({
          field: 'requestBody',
          message: `No request body defined for ${method} ${cleanPath}`,
          value: null
        });
        return { valid: false, errors };
      }

      // Resolve requestBody $ref if present (e.g., #/components/requestBodies/ManagePartyPostReq)
      if (requestBody.$ref) {
        console.log('Resolving requestBody $ref:', requestBody.$ref);
        requestBody = resolveRef(requestBody.$ref, oasObj, files, mainOasFile);
        console.log('RequestBody resolved');
      }

      const content = requestBody.content || {};
      const jsonContent = content['application/json'];
      console.log('JSON content:', jsonContent ? 'found' : 'not found');
      
      if (!jsonContent || !jsonContent.schema) {
        errors.push({
          field: 'schema',
          message: `No JSON schema defined for request body of ${method} ${path}`,
          value: null
        });
        return { valid: false, errors };
      }

      schema = jsonContent.schema;
      console.log('Schema has $ref?', schema.$ref ? 'yes: ' + schema.$ref : 'no');
    } else {
      // Validate response body
      const responses = methodDef.responses || {};
      // Try to find a success response (200, 201, etc.)
      const successCode = Object.keys(responses).find(code => code.startsWith('2'));
      if (!successCode) {
        errors.push({
          field: 'response',
          message: `No success response defined for ${method} ${cleanPath}`,
          value: null
        });
        return { valid: false, errors };
      }

      let responseDef = responses[successCode];
      
      // Resolve response $ref if present (e.g., #/components/responses/SuccessResponse)
      if (responseDef.$ref) {
        console.log('Resolving response $ref:', responseDef.$ref);
        responseDef = resolveRef(responseDef.$ref, oasObj, files, mainOasFile);
        console.log('Response resolved');
      }
      
      const content = responseDef.content || {};
      const jsonContent = content['application/json'];
      if (!jsonContent || !jsonContent.schema) {
        errors.push({
          field: 'schema',
          message: `No JSON schema defined for response of ${method} ${path}`,
          value: null
        });
        return { valid: false, errors };
      }

      schema = jsonContent.schema;
    }

    // Resolve $ref if present
    console.log('About to resolve schema $ref...');
    if (schema.$ref) {
      console.log('Resolving schema $ref:', schema.$ref);
      schema = resolveRef(schema.$ref, oasObj, files, mainOasFile);
      console.log('Schema resolved, has properties?', schema.properties ? 'yes' : 'no');
    }

    // Validate payload against schema
    console.log('Starting validateAgainstSchema...');
    validateAgainstSchema(payload, schema, '', errors, oasObj, files, mainOasFile);
    console.log('Validation complete, errors:', errors.length);

    return {
      valid: errors.length === 0,
      errors
    };
  } catch (error: any) {
    console.error('Validation error:', error);
    throw new Error(`Failed to validate payload: ${error.message}`);
  }
}

/**
 * Recursively resolve all $refs in an object
 */
function resolveAllRefs(obj: any, rootObj: any, files: { [key: string]: string }, mainFile: string, visited: Set<string> = new Set(), depth: number = 0): any {
  // Prevent stack overflow
  if (depth > 50) {
    console.warn('Maximum recursion depth reached in resolveAllRefs');
    return obj;
  }

  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map(item => resolveAllRefs(item, rootObj, files, mainFile, visited, depth + 1));
  }

  // Handle objects with $ref
  if (obj.$ref) {
    const ref = obj.$ref;
    
    // Prevent infinite loops
    if (visited.has(ref)) {
      console.warn(`Circular reference detected: ${ref}`);
      return {}; // Return empty object instead of the ref
    }
    
    visited.add(ref);
    const resolved = resolveRef(ref, rootObj, files, mainFile);
    
    // Recursively resolve the resolved object
    return resolveAllRefs(resolved, rootObj, files, mainFile, visited, depth + 1);
  }

  // Recursively resolve all properties
  const result: any = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      result[key] = resolveAllRefs(obj[key], rootObj, files, mainFile, visited, depth + 1);
    }
  }
  
  return result;
}

/**
 * Resolve a $ref reference in OAS
 */
function resolveRef(ref: string, oasObj: any, files: { [key: string]: string }, mainFile: string): any {
  if (ref.startsWith('#/')) {
    // Internal reference (e.g., #/components/schemas/User)
    const parts = ref.substring(2).split('/');
    let result = oasObj;
    for (const part of parts) {
      result = result[part];
      if (!result) {
        console.warn(`Could not resolve reference: ${ref}`);
        return {};
      }
    }
    return result;
  }
  
  // External file reference (e.g., ./schemas/User.yaml#/User or ./paths/orders.yaml)
  if (ref.includes('#') || ref.startsWith('./') || ref.startsWith('../')) {
    console.log('Resolving external ref:', ref);
    let filePath = ref;
    let jsonPath = '';
    
    // Split ref if it contains #
    if (ref.includes('#')) {
      [filePath, jsonPath] = ref.split('#');
    }
    
    // Resolve relative file path
    const mainDir = mainFile.substring(0, mainFile.lastIndexOf('/') + 1) || '';
    console.log('Main dir:', mainDir);
    console.log('File path:', filePath);
    
    // Normalize path: resolve ./ and ../
    let fullPath = mainDir + filePath;
    console.log('Full path before normalization:', fullPath);
    
    // Remove leading ./
    fullPath = fullPath.replace(/^\.\//, '');
    
    // Resolve ../ - split path and process each segment
    const pathParts = fullPath.split('/');
    const normalizedParts: string[] = [];
    
    for (const part of pathParts) {
      if (part === '..') {
        // Go up one directory - remove last part
        if (normalizedParts.length > 0) {
          normalizedParts.pop();
        }
      } else if (part !== '.' && part !== '') {
        normalizedParts.push(part);
      }
    }
    
    fullPath = normalizedParts.join('/');
    console.log('Full path after normalization:', fullPath);
    
    // Try multiple path variations
    let fileContent = files[fullPath] || files[filePath.replace(/^\.\.\//, '').replace(/^\.\//, '')] || files[filePath];
    console.log('File content found?', fileContent ? 'yes' : 'no');
    console.log('Trying to find:', fullPath);
    
    if (!fileContent) {
      console.warn(`Could not find external reference file: ${ref}`);
      console.warn(`Tried paths: ${fullPath}, ${filePath.replace(/^\.\//, '')}, ${filePath}`);
      console.warn(`Available files:`, Object.keys(files));
      return {};
    }
    
    console.log('Parsing external file...');
    try {
      // Parse the external file
      let externalObj: any;
      if (filePath.endsWith('.json')) {
        externalObj = JSON.parse(fileContent);
      } else {
        externalObj = yaml.load(fileContent) as any;
      }
      
      // Navigate to the specific path if provided
      if (jsonPath) {
        const parts = jsonPath.substring(1).split('/'); // Remove leading '/'
        let result = externalObj;
        for (const part of parts) {
          result = result[part];
          if (!result) {
            console.warn(`Could not resolve path in external file: ${jsonPath}`);
            return {};
          }
        }
        return result;
      }
      
      return externalObj;
    } catch (error) {
      console.warn(`Could not parse external reference file: ${fullPath}`, error);
      return {};
    }
  }
  
  console.warn(`Unsupported reference format: ${ref}`);
  return {};
}

/**
 * Validate a value against an OAS schema
 */
function validateAgainstSchema(
  value: any,
  schema: any,
  path: string,
  errors: any[],
  oasObj: any,
  files: { [key: string]: string },
  mainFile: string,
  depth: number = 0
): void {
  // Prevent infinite recursion
  if (depth > 100) {
    console.warn('Maximum validation depth reached at path:', path);
    return;
  }
  
  console.log(`Validating at path: ${path || 'root'}, depth: ${depth}`);
  
  // Resolve $ref if present
  if (schema.$ref) {
    console.log(`Resolving $ref at ${path}: ${schema.$ref}`);
    schema = resolveRef(schema.$ref, oasObj, files, mainFile);
  }

  const currentPath = path || 'root';

  // Check type
  const expectedType = schema.type;
  const actualType = Array.isArray(value) ? 'array' : typeof value;

  if (expectedType && expectedType !== actualType) {
    if (!(expectedType === 'integer' && actualType === 'number')) {
      errors.push({
        field: currentPath,
        message: `Expected type '${expectedType}' but got '${actualType}'`,
        value: value,
        expected: expectedType
      });
      return;
    }
  }

  // Validate based on type
  if (expectedType === 'object' || schema.properties) {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({
        field: currentPath,
        message: `Expected object but got ${Array.isArray(value) ? 'array' : typeof value}`,
        value: value
      });
      return;
    }

    // Check required properties
    const required = schema.required || [];
    for (const prop of required) {
      if (!(prop in value)) {
        errors.push({
          field: `${currentPath}.${prop}`,
          message: `Required property '${prop}' is missing`,
          value: undefined,
          expected: 'required'
        });
      }
    }

    // Validate each property
    const properties = schema.properties || {};
    for (const [prop, propSchema] of Object.entries(properties)) {
      if (prop in value) {
        validateAgainstSchema(
          value[prop],
          propSchema,
          currentPath === 'root' ? prop : `${currentPath}.${prop}`,
          errors,
          oasObj,
          files,
          mainFile,
          depth + 1
        );
      }
    }

    // Check for additional properties if additionalProperties is false
    if (schema.additionalProperties === false) {
      for (const prop of Object.keys(value)) {
        if (!(prop in properties)) {
          errors.push({
            field: `${currentPath}.${prop}`,
            message: `Additional property '${prop}' is not allowed`,
            value: value[prop]
          });
        }
      }
    }
  } else if (expectedType === 'array' || schema.items) {
    if (!Array.isArray(value)) {
      errors.push({
        field: currentPath,
        message: `Expected array but got ${typeof value}`,
        value: value
      });
      return;
    }

    // Validate array items
    if (schema.items) {
      value.forEach((item, index) => {
        validateAgainstSchema(
          item,
          schema.items,
          `${currentPath}[${index}]`,
          errors,
          oasObj,
          files,
          mainFile,
          depth + 1
        );
      });
    }

    // Check minItems/maxItems
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({
        field: currentPath,
        message: `Array length ${value.length} is less than minimum ${schema.minItems}`,
        value: value.length,
        expected: `>= ${schema.minItems}`
      });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({
        field: currentPath,
        message: `Array length ${value.length} exceeds maximum ${schema.maxItems}`,
        value: value.length,
        expected: `<= ${schema.maxItems}`
      });
    }
  } else if (expectedType === 'string') {
    if (typeof value !== 'string') {
      errors.push({
        field: currentPath,
        message: `Expected string but got ${typeof value}`,
        value: value
      });
      return;
    }

    // Check pattern
    if (schema.pattern) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push({
          field: currentPath,
          message: `String does not match pattern '${schema.pattern}'`,
          value: value,
          expected: schema.pattern
        });
      }
    }

    // Check minLength/maxLength
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        field: currentPath,
        message: `String length ${value.length} is less than minimum ${schema.minLength}`,
        value: value.length,
        expected: `>= ${schema.minLength}`
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({
        field: currentPath,
        message: `String length ${value.length} exceeds maximum ${schema.maxLength}`,
        value: value.length,
        expected: `<= ${schema.maxLength}`
      });
    }

    // Check enum
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({
        field: currentPath,
        message: `Value '${value}' is not in allowed enum values`,
        value: value,
        expected: schema.enum.join(', ')
      });
    }
  } else if (expectedType === 'number' || expectedType === 'integer') {
    if (typeof value !== 'number') {
      errors.push({
        field: currentPath,
        message: `Expected number but got ${typeof value}`,
        value: value
      });
      return;
    }

    // Check integer
    if (expectedType === 'integer' && !Number.isInteger(value)) {
      errors.push({
        field: currentPath,
        message: `Expected integer but got decimal number`,
        value: value
      });
    }

    // Check minimum/maximum
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({
        field: currentPath,
        message: `Value ${value} is less than minimum ${schema.minimum}`,
        value: value,
        expected: `>= ${schema.minimum}`
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({
        field: currentPath,
        message: `Value ${value} exceeds maximum ${schema.maximum}`,
        value: value,
        expected: `<= ${schema.maximum}`
      });
    }
  } else if (expectedType === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push({
        field: currentPath,
        message: `Expected boolean but got ${typeof value}`,
        value: value
      });
    }
  }
}

/**
 * Validate request parameters (query, path, header, cookie)
 */
function validateParameters(
  parameters: any[],
  paramValues: any,
  errors: any[],
  oasObj: any,
  files: { [key: string]: string },
  mainFile: string
): void {
  console.log('Validating parameters:', parameters.length);
  
  for (const param of parameters) {
    let paramDef = param;
    
    // Resolve parameter $ref if present
    if (paramDef.$ref) {
      console.log('Resolving parameter $ref:', paramDef.$ref);
      paramDef = resolveRef(paramDef.$ref, oasObj, files, mainFile);
    }
    
    const paramName = paramDef.name;
    const paramIn = paramDef.in; // 'query', 'path', 'header', 'cookie'
    const required = paramDef.required || false;
    const schema = paramDef.schema || {};
    
    console.log(`Checking parameter: ${paramName} (${paramIn}), required: ${required}`);
    
    // Check if parameter value is provided
    // For headers, do case-insensitive lookup
    let paramValue;
    if (paramIn === 'header') {
      // Create a case-insensitive lookup for headers
      const lowerParamName = paramName.toLowerCase();
      const matchingKey = Object.keys(paramValues).find(
        key => key.toLowerCase() === lowerParamName
      );
      paramValue = matchingKey ? paramValues[matchingKey] : undefined;
    } else {
      // For query, path, cookie - exact match
      paramValue = paramValues[paramName];
    }
    
    if (required && (paramValue === undefined || paramValue === null || paramValue === '')) {
      errors.push({
        field: paramName,
        message: `Required ${paramIn} parameter '${paramName}' is missing`,
        value: paramValue,
        expected: 'required'
      });
      continue;
    }
    
    // If not required and not provided, skip validation
    if (paramValue === undefined || paramValue === null) {
      continue;
    }
    
    // Validate parameter value against schema
    if (schema) {
      // Resolve schema $ref if present
      let resolvedSchema = schema;
      if (schema.$ref) {
        resolvedSchema = resolveRef(schema.$ref, oasObj, files, mainFile);
      }
      
      // Convert string values to appropriate types based on schema
      let convertedValue = paramValue;
      if (typeof paramValue === 'string' && resolvedSchema.type) {
        if (resolvedSchema.type === 'integer' || resolvedSchema.type === 'number') {
          convertedValue = Number(paramValue);
          if (isNaN(convertedValue)) {
            errors.push({
              field: paramName,
              message: `Parameter '${paramName}' should be a ${resolvedSchema.type} but got '${paramValue}'`,
              value: paramValue,
              expected: resolvedSchema.type
            });
            continue;
          }
        } else if (resolvedSchema.type === 'boolean') {
          if (paramValue === 'true') convertedValue = true;
          else if (paramValue === 'false') convertedValue = false;
          else {
            errors.push({
              field: paramName,
              message: `Parameter '${paramName}' should be a boolean but got '${paramValue}'`,
              value: paramValue,
              expected: 'true or false'
            });
            continue;
          }
        } else if (resolvedSchema.type === 'array') {
          // For array parameters, value might be comma-separated or already an array
          if (typeof paramValue === 'string') {
            convertedValue = paramValue.split(',').map(v => v.trim());
          }
        }
      }
      
      // Validate the converted value against the schema
      validateAgainstSchema(convertedValue, resolvedSchema, paramName, errors, oasObj, files, mainFile);
    }
  }
}
