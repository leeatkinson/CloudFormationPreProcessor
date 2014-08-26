CloudFormation PreProcessor
===========================

A pre-processsor for AWS CloudFormation. 

Features
--------
* Update to the current AMIs - for example, the 'latest' Windows 2012 AMI from Amazon. 'Latest' is determined by sorting their names alphabetically and selecting the last.
* Include external files into UserData and CloudFormation-Init files and commands, parsing content for { "Ref", ...} and { "Fn::GetAttr" }.

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

If required, create a JSON file who's path is the same as template but has an extra .config extension. For file includes, create a folder who's path is the same as the template but has an extra .includes extension. For example:

* Template = MyTemplate.cloudformation
* Config = MyTemplate.cloudformation.config
* Includes = MyTemplate.cloudformation.includes/

The format of the config file is:

```json
{
    "mappings": {
        ...
        "<mapping-name>": {
            "type": "ami",
            "ami:owner": "<owner>",
            "ami:name": "Windows_Server-2012-RTM-English-64Bit-Base*"
        },
        ...
    }
}
```

If ami:owner is unspecified, 'amazon' is used.

The UserData include is placed directly in .includes directory and named 'userdata'. If the UserData file has a .ps1 or .cmd file extension, the content is wrapped with &lt;powershell&gt;&lt;/powershell&gt; or &lt;script&gt;&lt;/script&gt; tags as appropriate before including in the template.

For CloudFormation-Init files and commands, these are placed heirachically within the .includes directory, such as:

MyTemplate.cloudformation.includes/&lt;resource-name&gt;/&lt;configs&gt;/&lt;config-name&gt;/&lt;files|commands&gt;/&lt;key&gt;/

For specifying a drive letter for Windows instances use the $ character instead of the : character (e.g. C$ instead of C:). For example, 'MyTemplate.cloudformation.includes/MyResource/MyConfig/files/C$/folder/file' will be used for the file with key 'C:/folder/file'.

For specifying hidden files (without hiding them on you development machine) use $. names. For example, 'MyTemplate.cloudformation.includes/MyResource/MyConfig/files/folder/$.file' will be used for the file with key 'folder/.file'.

Within include files, you can use {{ref foo}} and {{att foo bar}} and these will be converted to the appropriate cloudformation template objects { "Ref": "foo" } and { "Fn:GetAtt": [ "foo", "bar" ] }.

Execution
---------

You can execute the CloudFormation PreProcessor without any arguments, and it will pre-process all templates with .cloudformation file extension in the current working directory.

```bash
cfnpp
```

To specify a different file pattern, use the -t or --template argument.

```bash
cfnpp -t *.json
```
