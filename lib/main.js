"use strict"

var fs = require("fs");
var path = require("path");

var aws = require("aws-sdk");
var glob = require("glob");
var jsonFile = require("jsonfile");
var console = require("better-console");

function log(message, data, callback, callbackData) {
	if (data) message += "\t" + JSON.stringify(data);
	console.log(message);
	if (callback) callback(null, callbackData);
}
function logWithError(message, data, error, callback, callbackData) {
	if (error) {
		if (data) message += "\t" + JSON.stringify(data);
		message += "\t" + error;
		console.error(message);
		callback(error, callbackData);
	}
	else log(message, data);
}

function getEC2Client(regionName) {
	return new aws.EC2( { region: regionName } );
}

function preProcess(regionName, templatePathPatterns, callback) {
	getEC2Client(regionName).describeRegions(function(error, result) {
		if (error) preProcessCallback("Unable to get region names", error);
		else {
			var regionNames = result.Regions.map(function(o) { return o.RegionName; });
			if (!Array.isArray(templatePathPatterns) || templatePathPatterns.length == 0) templatePathPatterns = [ "./*.cloudformation" ];
			templatePathPatterns.forEach(function(templatePathPattern) {
				var templatePathPatternInfo = { pathPattern: templatePathPattern };
				glob(templatePathPattern, function (error, templatePaths) {
					if (error) preProcessCallback("Unable to find templates", templatePathPatterns, error);
					else {
						var templatesToDo = templatePaths.length;
						var templateCallback = function(message, data, error) {
							logWithError(message, data, error, callback);
							if (--templatesToDo === 0) log("Templates processed", { paths: templatePaths }, callback, templatePaths);
						};
						templatePaths.forEach(function(templatePath) {
							var templateName = path.basename(templatePath);
							var templateDirectory = path.dirname(templatePath);
							var templateInfo = { name : templateName };
							jsonFile.readFile(templatePath, function (error, template) {
								if (error) templateCallback("Unable to read template", templateInfo, error);
								else {
									var tasksToDo = 2; // includes + ami mappings
									var templateTaskCallback = function(message, data, error) {
										logWithError(message, data, error, templateCallback);
										if (error) templateCallback("Template not saved", templateInfo);
										else if (--tasksToDo === 0 ) {
											jsonFile.writeFile(templatePath, template, function(error) {
												templateCallback(error ? "Unable to save template" : "Template processed", templateInfo, error);
											});
										}
									}
									log("Processing template", { name : templateName, tasks: tasksToDo });
									var includesPath = templatePath + ".includes";
									var includePathsPattern = includesPath + "/**";
									glob(includePathsPattern, function(error, includePaths) {
										if (error) templateTaskCallback("Unable to get include paths", { pattern : includePathsPattern }, error);
										else {
											var includePathsToProcess = includePaths.length;
											var includePathCallback = function(message, data, error) {
												logWithError(message, data, error, templateTaskCallback);
												if (--includePathsToProcess === 0) templateTaskCallback("Includes completed", templateInfo);
											};
											log("Includes found", { name : templateName, includes: includePathsToProcess });
											includePaths.forEach(function(includePath) {
												log("Include", { name : templateName, path: includePath });
												var relativePath = path.relative(includesPath, includePath);
												var includePathInfo = { path: relativePath };
												var pathParts = relativePath.split(path.sep);
												if ((pathParts.length < 3) || !pathParts[2].match(/files|commands/) || pathParts.some(function(pathPart) { return pathPart === "."; })) 
													includePathCallback("Non-candidate include found", includePathInfo);
												else {
													fs.stat(includePath, function(error, stat) {
														if (error) includePathCallback("Unable to get file stats", matchingPathInfo, error);
														else if (!stat.isFile()) includePathCallback();
														else {
															//need to support ignoring of windows system/hidden files here
															fs.readFile(includePath, "utf8", function (error, content) {
																if (error) includePathCallback(err.errno == 34 ? "Include file not found" : "Unable to read include file", includeInfo, error);
																else {
																	var relative = path.relative(includesPath, includePath);
																	var relativeParts = relative.split(path.sep);
																	var resourceKey = relativeParts[0];
																	var configKey = relativeParts[1];
																	var type = relativeParts[2];
																	var keyParts = relativeParts.slice(3);
																	for (var i = 0; i < keyParts.length; i++) {
																		var original = keyParts[i];
																		var working = original;
																		//if first part is e.g. C$, change to C:
																		if (i == 0) {
																			var match = working.match(/^([A-z])\$$/);
																			if (match) working = match[1] + ":";
																		}
																		//if part starts with $$ or $., remove the first $
																		var match = working.match(/^\$(\.\$.*)$/)
																		if (match) working = match[1];
																		if (working !== original) keyParts[i] = working;
																	}
																	var key = keyParts.join("/");
																	var templateInclude = template.Resources[resourceKey].Metadata["AWS::CloudFormation::Init"][configKey][type][key];
																	var includeInfo = { template: templateName, resource: resourceKey, config: configKey, type: type, key: key };
																	if (!templateInclude) includePathCallback("Template include key not found", includeInfo);
																	else {
																		var contentArray = [];
																		for (var i = 0; ; true) {
																			var searchString = content.substring(i);
																			var match = searchString.match(/(?:\{\{(ref) ([\w.:]*)\}\})|(?:\{\{(att) (\w*) ([\w.]*)\}\})/);
																			var stringToPush = null;
																			if (!match) stringToPush = searchString;
																			else {
																				var j = match.index;
																				if (j > 0) stringToPush = searchString.substring(0, j);
																			}
																			if (stringToPush) {
																				var lastIndex = contentArray.length - 1;
																				if (lastIndex > -1) {
																					var last = contentArray[lastIndex];
																					if (typeof last === "string") {
																						contentArray[lastIndex] = last + str;
																						stringToPush = null;
																					}
																				}
																				if (stringToPush) contentArray.push(stringToPush);
																			}
																			if (!match) break;
																			var variableType = (match[1] || match[3]);
																			if (variableType) {
																				var variable = null;
																				switch (variableType) {
																					case "ref":
																						variable = { "Ref": match[2]};
																						break;
																					case "att":
																						variable = { "Fn::GetAtt": [ match[4], match[5] ] };
																						break;
																				}
																				contentArray.push(variable);
																				log("Variable found", { "string": match[0], "object": JSON.stringify(variable) });
																			}
																			i += j + match[0].length;
																		}
																		includeInfo.variableCount = contentArray.filter(function(o) { return typeof o === "object" }).length;
																		templateInclude[type == "files" ? "content" : "command"] = (contentArray.length === 1) ? contentArray[0] : { "Fn::Join": [ "", contentArray ] };
																		includePathCallback("File included", includeInfo);
																	}
																}
															});
														}
													});
												}
											});
										}
									});

									var configPath = templatePath + ".cfnpp";
									jsonFile.readFile(configPath, function(error, config) {
										if (error) {
											if (err.no == 34) templateTaskCallback("Config not found", configInfo);
											else templateTaskCallback("Unable to read config", configInfo, error);
										}
										else {
											var amiMappings = config.amiMappings;
											if (!amiMappings) amiMappings = [];
											else {
												amiMappings = Object.keys(amiMappings).map(function(o) {
													var amiMapping = amiMappings[o];
													return { 
														key: o,
														owner: amiMapping.owner || "amazon",
														name: amiMapping.name
													};
												});
											}
											var amiMappingsToDo = amiMappings.length;
											var amiMappingsCallback = function(message, data, error) {
												logWithError(message, data, error, templateTaskCallback);
												if (--amiMappingsToDo === 0) templateTaskCallback("AMIs mapped", templateInfo);
											};
											amiMappings.forEach(function(amiMapping) {
												var key = amiMapping.key;
												var owner = amiMapping.owner;
												var name = amiMapping.name;
												var amiInfo = { key: key, owner: owner, name: name };
												var templateMapping = template.Mappings[key];
												if (!templateMapping) amiMappingsTaskCallback("AMI mapping not required", amiInfo);
												else {
													var amiMappingRegionsToDo = regionNames.length;
													var amiMappingRegionCallback = function(message, data, error) {
														logWithError(message, data, error, amiMappingsCallback);
														if (--amiMappingRegionsToDo === 0) amiMappingsCallback("Regions AMI-mapped", amiInfo);
													};
													regionNames.forEach(function(regionName) {
														amiInfo.regionName = regionName;
														log("Searching for AMI", amiInfo);
														getEC2Client(regionName).describeImages({ 
															Owners: [ owner ], 
															Filters: [ { Name: "name", Values: [ name ] } ]
														}, function(error, result) {
															if (error) amiMappingRegionCallback("AMI not found", amiInfo, error);
															else {
																var images = result.Images.sort(function(a, b) {
																	var a = a.Name;
																	var b = b.Name;
																	return (a > b) ? 1 : ((a < b) ? -1 : 0);
																});
																if (images.length == 0) amiMappingRegionCallback("AMI not found", amiInfo);
																else {
																	var amiId = images[0].ImageId;
																	amiInfo.id = amiId;
																	templateMapping[regionName] = { ID: amiId };
																	amiMappingRegionCallback("AMI set", amiInfo);
																}
															}
														});
													});
												}
											});
										}
									});
								}
							});
						});
					}
				});
			});
		}
	});
}

module.exports = preProcess;
