const { exec } = require("child_process");
const { promisify } = require("util");
const { log } = require("../src/util");
const { UP, DOWN } = require("../src/util");
const fs = require("fs");
const path = require("path");
const { tmpdir } = require("os");

const execAsync = promisify(exec);

/**
 * Execute pre-notification command based on monitor status
 * @param {number} status Monitor status (UP=1, DOWN=0)
 * @param {Object} monitorJSON Monitor details
 * @returns {Promise<void>}
 */
async function executePreCommand(status, monitorJSON) {
    let command = null;
    let statusText = "";

    // Determine which command to execute based on status
    if (status === UP && monitorJSON?.pre_up_command) {
        command = monitorJSON.pre_up_command.trim();
        statusText = "UP";
    } else if (status === DOWN && monitorJSON?.pre_down_command) {
        command = monitorJSON.pre_down_command.trim();
        statusText = "DOWN";
    }

    // Execute the command if it exists
    if (command) {
        try {
            // Process multi-line commands
            const processedCommand = processMultiLineCommand(command);
            
            log.info("monitor", `Executing ${statusText} pre-command for monitor: ${monitorJSON?.name || 'Unknown'}`);
            log.debug("monitor", `Original command: ${command}`);
            log.debug("monitor", `Processed command: ${processedCommand}`);
            
            // For complex commands with many quotes, use temporary script files
            // to avoid shell escaping issues
            let stdout, stderr;
            let tempFile = null;
            
            try {
                if (isComplexCommand(processedCommand)) {
                    // Use temporary file approach for complex commands
                    tempFile = await createTempScript(processedCommand);
                    log.debug("monitor", `Using temp script: ${tempFile}`);
                    
                    if (process.platform === 'win32') {
                        const { stdout: out, stderr: err } = await execAsync(`cmd.exe /c "${tempFile}"`, {
                            timeout: 30000,
                            maxBuffer: 1024 * 1024,
                            windowsHide: true
                        });
                        stdout = out;
                        stderr = err;
                    } else {
                        const { stdout: out, stderr: err } = await execAsync(`bash "${tempFile}"`, {
                            timeout: 30000,
                            maxBuffer: 1024 * 1024
                        });
                        stdout = out;
                        stderr = err;
                    }
                } else {
                    // Simple command, execute directly
                    let execOptions;
                    if (process.platform === 'win32') {
                        execOptions = {
                            timeout: 30000,
                            maxBuffer: 1024 * 1024,
                            shell: 'cmd.exe',
                            windowsHide: true
                        };
                    } else {
                        execOptions = {
                            timeout: 30000,
                            maxBuffer: 1024 * 1024,
                            shell: '/bin/bash'
                        };
                    }
                    
                    const result = await execAsync(processedCommand, execOptions);
                    stdout = result.stdout;
                    stderr = result.stderr;
                }
            } finally {
                // Clean up temporary file
                if (tempFile) {
                    try {
                        fs.unlinkSync(tempFile);
                    } catch (err) {
                        log.warn("monitor", `Failed to cleanup temp file ${tempFile}: ${err.message}`);
                    }
                }
            }

            if (stdout) {
                log.debug("monitor", `Pre-command stdout: ${stdout}`);
            }
            if (stderr) {
                log.warn("monitor", `Pre-command stderr: ${stderr}`);
            }

            log.info("monitor", `${statusText} pre-command executed successfully`);
        } catch (error) {
            log.error("monitor", `Failed to execute ${statusText} pre-command: ${error.message}`);
            
            // Log more details about the error
            if (error.code) {
                log.error("monitor", `Command exit code: ${error.code}`);
            }
            if (error.stdout) {
                log.error("monitor", `Command stdout: ${error.stdout}`);
            }
            if (error.stderr) {
                log.error("monitor", `Command stderr: ${error.stderr}`);
            }
            
            // Don't throw the error - we still want to send notifications
            // even if the pre-command fails
        }
    }
}

/**
 * Process multi-line commands to handle line continuations and formatting
 * @param {string} command Raw command string from user input
 * @returns {string} Processed single-line command
 */
function processMultiLineCommand(command) {
    if (!command || typeof command !== 'string') {
        return '';
    }

    // Split into lines and process each line
    let lines = command.split('\n').map(line => line.trim());
    
    // Remove empty lines
    lines = lines.filter(line => line.length > 0);
    
    // Process line continuation with backslashes
    let processedLines = [];
    let currentLine = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check if line ends with backslash (line continuation)
        if (line.endsWith('\\')) {
            // Remove the backslash and add to current line
            currentLine += line.slice(0, -1).trim() + ' ';
        } else {
            // Complete the current line
            currentLine += line;
            processedLines.push(currentLine.trim());
            currentLine = '';
        }
    }
    
    // Handle case where last line had backslash but no following line
    if (currentLine.trim()) {
        processedLines.push(currentLine.trim());
    }
    
    // Join all processed lines with spaces, but preserve JSON structure
    let result = processedLines.join(' ');
    
    // Clean up extra spaces but preserve JSON formatting
    result = result.replace(/\s+/g, ' ').trim();
    
    // Fix JSON formatting specifically for -d parameter
    result = result.replace(/-d\s*'([^']*{[^}]*}[^']*)'/g, (match, jsonContent) => {
        // Compact JSON by removing extra whitespace
        const compactJson = jsonContent.replace(/\s+/g, ' ').trim();
        return `-d '${compactJson}'`;
    });
    
    // Handle special cases for curl commands
    if (result.toLowerCase().includes('curl')) {
        // Fix common curl formatting issues
        result = fixCurlCommand(result);
    }
    
    return result;
}

/**
 * Fix common curl command formatting issues
 * @param {string} curlCommand Curl command string
 * @returns {string} Fixed curl command
 */
function fixCurlCommand(curlCommand) {
    let fixed = curlCommand;
    
    // Windows-specific fixes for cmd.exe
    if (process.platform === 'win32') {
        log.debug("monitor", `Windows curl fix - Original: ${fixed}`);
        
        // Handle -d parameters with JSON data BEFORE converting quotes
        // Look for patterns like -d '{ ... }' and handle them specially
        fixed = fixed.replace(/-d\s*'([^']*{[^}]*}[^']*)'/g, (match, jsonContent) => {
            log.debug("monitor", `Found JSON data parameter: ${match}`);
            
            // For JSON data in Windows cmd, we need to escape internal quotes
            // and wrap the whole thing in double quotes
            const escapedJson = jsonContent.replace(/"/g, '\\"');
            const result = `-d "${escapedJson}"`;
            log.debug("monitor", `JSON parameter converted: ${result}`);
            return result;
        });
        
        // Now replace remaining single quotes with double quotes for Windows cmd.exe
        // cmd.exe doesn't recognize single quotes as string delimiters
        fixed = fixed.replace(/'/g, '"');
        
        log.debug("monitor", `Windows curl fix - After quote conversion: ${fixed}`);
        
        // Clean up multiple spaces
        fixed = fixed.replace(/\s+/g, ' ').trim();
        
    } else {
        // Unix systems - keep original logic
        fixed = fixed
            // Fix header spacing: -H'header' -> -H 'header'
            .replace(/-H'/g, "-H '")
            .replace(/-H"/g, '-H "')
            // Fix data spacing: -d'data' -> -d 'data'  
            .replace(/-d'/g, "-d '")
            .replace(/-d"/g, '-d "')
            // Fix method spacing: -X'PUT' -> -X 'PUT'
            .replace(/-X'/g, "-X '")
            .replace(/-X"/g, '-X "')
            // Clean up multiple spaces
            .replace(/\s+/g, ' ')
            .trim();
    }
        
    return fixed;
}

/**
 * Check if a command is complex and should use temporary file approach
 * @param {string} command Command to check
 * @returns {boolean} True if command is complex
 */
function isComplexCommand(command) {
    // Consider command complex if it has multiple headers or complex quotes
    const complexPatterns = [
        /User-Agent:/i,         // User-Agent header usually contains spaces
        /Mozilla/i,             // Mozilla string in User-Agent
        /-H.*['"].*,.*['"].*-H/i,  // Multiple headers
        /curl.*-H.*-H.*-H/i,    // Multiple -H flags
    ];
    
    return complexPatterns.some(pattern => pattern.test(command));
}

/**
 * Create temporary script file for complex commands
 * @param {string} command Command to write to script
 * @returns {Promise<string>} Path to temporary script file
 */
async function createTempScript(command) {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    
    let scriptFile, scriptContent;
    
    if (process.platform === 'win32') {
        // For Windows, use batch script to avoid PowerShell curl alias issues
        scriptFile = path.join(tmpdir(), `pre_command_${timestamp}_${randomId}.bat`);
        scriptContent = `@echo off
REM Pre-notification command script
REM Execute the command
${command}
`;
    } else {
        // Bash script
        scriptFile = path.join(tmpdir(), `pre_command_${timestamp}_${randomId}.sh`);
        scriptContent = `#!/bin/bash
# Pre-notification command script
set -e

# Execute the command
${command}
`;
    }
    
    // Write script to file
    fs.writeFileSync(scriptFile, scriptContent, 'utf8');
    
    // Make script executable on Unix systems
    if (process.platform !== 'win32') {
        fs.chmodSync(scriptFile, 0o755);
    }
    
    return scriptFile;
}

module.exports = {
    executePreCommand
}; 