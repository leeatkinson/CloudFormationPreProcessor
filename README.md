CloudFormation PreProcessor
===========================

A pre-processsor for AWS CloudFormation. 

Features
--------
* Update to the current AMIs - for example, the 'latest' Windows 2012 AMI from Amazon. 'Latest' is determined by sorting their names alphabetically and selecting the last.
* Include CFN-init files and commands.

Preparation
-----------

Create your CloudFormation template as normal. Make sure that AMI mappings in the Mappings template section are of the format:

```json
{
    ...
    "Mappings": {
        ...
        "<mapping-name>": {
            "us-west-1": { "ID": "<ami-id>" },
            "ap-southeast-1": { "ID": "<ami-id>" },
            ...
        },
    ...
}
```

Create a JSON file who's file path is the same as template but has an extra file extension. For example:

* Template = /Users/lee/Documents/MyTemplate.cloudformation
* Config = /Users/lee/Documents/MyTemplate.cloudformation.&lt;whatever&gt;

The format of the config file is:

```json
{
    "amiMappings": {
        "<name>": {
            "owner": "<owner>",
            "name": "Windows_Server-2012-RTM-English-64Bit-Base*"
        }
    },
    "includes": {
        "directory": "<relative-path-of-files>",
        "resources": {
            "<name>": {
                "config|<configset-name>": {
                    "files": {
                        "/directory/foo.txt": { 
                            "path: "foo.txt" 
                        }
                    },
                    "commands": {
                        "1-install-bar": { 
                            "content: "run-installer" 
                        }
                    }
                }
            }
        }
    }
}
```
* If amiMappings.<name>.owner is unspecified, 'amazon' is used.
* If includes.directory is unspecified, the template path, with '.includes' appended, is used.
* The include path is located relative to the includes.directory path, which in turn is relative to the cloudformation template path.

Execution
---------

You can execute cfnpp without any arguments, and it will pre-process templates using any configuration files with .cfnpp extensions. 

```bash
cfnpp
```

If you are using a different file extension for your configuration files, use the -f or --config-file-pattern argument.

```bash
cfnpp -f *.preprocessconfig
```
