$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Concurrent;
namespace Sitecore.Configuration { public static class Settings { public static string DataFolder; } }
namespace Sitecore {
 public static class MainUtil {
  public static string PhysicalDataRoot;
  public static string MapPath(string value) { return value == "~/App_Data" ? PhysicalDataRoot : null; }
 }
}
namespace System.Web {
 public sealed class RequestStub { public Uri Url; }
 public sealed class ContextStub { public RequestStub Request = new RequestStub(); }
 public static class HttpContext { public static ContextStub Current = new ContextStub(); }
}
namespace Sitecore.Sites {
 public sealed class DatabaseStub { public string Name = "web"; }
 public sealed class SiteStub { public string Name; public DatabaseStub Database = new DatabaseStub(); }
 public static class SiteContextFactory {
  public static SiteStub GetSiteContext(string name) { return name == "source" ? new SiteStub { Name=name } : null; }
 }
}
public sealed class LayoutTestServer : IDisposable {
 readonly HttpListener listener = new HttpListener();
 public readonly ConcurrentQueue<string> Requests = new ConcurrentQueue<string>();
 public string Origin;
 public static string Payload = "{ \"sitecore\": { \"context\": {\"language\":\"en\"}, \"route\": {\"name\":\"Home\",\"fields\":{\"html\":{\"value\":\"<p>Ü & hello</p>\"}},\"placeholders\":{\"main\":[{\"uid\":\"{ABC}\",\"fields\":{\"n\":{\"value\":9007199254740993}}},{\"uid\":\"{ABC}\",\"fields\":{}}]}}}}";
 public LayoutTestServer() {
  var port = new TcpListener(IPAddress.Loopback,0);port.Start();int n=((IPEndPoint)port.LocalEndpoint).Port;port.Stop();
  Origin="http://127.0.0.1:"+n;listener.Prefixes.Add(Origin+"/");listener.Start();
  Task.Run(async()=>{while(listener.IsListening){try { var c=await listener.GetContextAsync(); _ = Task.Run(()=>Handle(c)); } catch { break; }}});
 }
 async Task Handle(HttpListenerContext c) {
  try {
   var q=c.Request.QueryString;string item=q["item"], key=q["sc_apikey"];
   Requests.Enqueue(c.Request.Url.AbsolutePath+"|"+item+"|"+q["sc_site"]+"|"+q["sc_lang"]+"|"+(!String.IsNullOrEmpty(key)));
   string body=Payload;c.Response.ContentType="application/json";
   if(item=="/slow")await Task.Delay(2000);
   if(item=="/null")body="{\"sitecore\":{\"route\":null}}";
   if(item=="/html"){body="<html>failure</html>";c.Response.ContentType="text/html";}
   if(item=="/error"){c.Response.StatusCode=500;body=key;}
   if(item=="/redirect"){c.Response.StatusCode=302;c.Response.RedirectLocation=Origin+"/leak?sc_apikey="+key;}
   if(item=="/broken")body="{";
   if(item=="/echo")body="{\"sitecore\":{\"context\":{},\"route\":{\"fields\":{\"key\":\""+key+"\"},\"placeholders\":{}}}}";
   if(item=="/wrong-shape")body="{\"sitecore\":{\"context\":{},\"route\":{\"fields\":\"not fields\",\"placeholders\":[]}}}";
   if(item=="/escaped") {
    string encoded="";foreach(char ch in key)encoded+="\\u"+((int)ch).ToString("x4");
    body="{\"sitecore\":{\"context\":{},\"route\":{\"fields\":{\"value\":\""+encoded+"\"},\"placeholders\":{}}}}";
   }
   if(item=="/large")body="{\"sitecore\":{\"context\":{},\"route\":{\"fields\":{\"html\":{\"value\":\""+new string('x',4*1024*1024)+"\"}},\"placeholders\":{}}}}";
   if(item=="/chunked"){body=new string('x',8192);c.Response.SendChunked=true;}
   byte[] bytes=Encoding.UTF8.GetBytes(body);if(!c.Response.SendChunked)c.Response.ContentLength64=bytes.Length;
   await c.Response.OutputStream.WriteAsync(bytes,0,bytes.Length);
  } catch {} finally { c.Response.Close(); }
 }
 public void Dispose(){listener.Close();}
}
'@
function Assert($condition,[string]$message) { if(-not $condition){ throw "Assertion failed: $message" } }
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('layout-capture-test-'+[guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
[Sitecore.MainUtil]::PhysicalDataRoot=$testRoot
[Sitecore.Configuration.Settings]::DataFolder='~/App_Data'
$script:testApiKey=[guid]::NewGuid()
function Get-Item {
 param($Path,$ErrorAction)
 if($Path -ne 'master:/sitecore/system/Settings/Services/API Keys/capture') { throw 'Unknown lookup' }
 [pscustomobject]@{ ID=$script:testApiKey; Paths=[pscustomobject]@{FullPath='/sitecore/system/Settings/Services/API Keys/capture'} }
}
$server=[LayoutTestServer]::new()
[System.Web.HttpContext]::Current=$null
function Capture([string[]]$Items, [hashtable]$Overrides=@{}) {
 $Database='web';$Version='latest';$Mode='delivery';$Device='site-default'
 $ApprovedOrigin=$server.Origin;$APIKeyItemPath='/sitecore/system/Settings/Services/API Keys/capture'
 $KajooSourceOrigin=$server.Origin # Reserved connector injection, never a user parameter.
 $TimeoutSeconds=1;$MaxResponseBytes=8*1024*1024;$MaxItems=100
 $Routes=@($Items | ForEach-Object { @{item=$_;site='source';language='en'} })
 foreach($name in $Overrides.Keys) { Set-Variable -Name $name -Value $Overrides[$name] }
 . "$PSScriptRoot/../scripts/remote-common.ps1"
 try { . "$PSScriptRoot/../scripts/capture/export-layouts.ps1" }
 finally { foreach($writer in $script:kajooWriters.Values){$writer.Dispose()} }
}
try {
 Assert (Test-Path "$PSScriptRoot/../scripts/capture/export-layouts.ps1") 'capture entrypoint exists'
 $result=Capture @('/good','/null','/html','/error','/redirect','/broken','/echo','/large','/slow','/good','/wrong-shape','/escaped')
 $manifest=$result | ConvertFrom-Json
 Assert ($manifest.kind -eq 'kajoo-export') 'common export envelope'
 Assert $manifest.summary.partial 'failed routes mark summary partial'
 $indexPath=($manifest.files | Where-Object name -eq 'layouts.jsonl').path
 $records=@([IO.File]::ReadAllLines((Join-Path $testRoot $indexPath)) | ForEach-Object { $_ | ConvertFrom-Json })
 Assert ($records.Count -eq 12) 'every input has a status including duplicate'
 Assert ($records[0].success -eq $true) 'actual HTTP layout captured'
 Assert ($records[1].error -eq 'null-route') 'null route failure'
 Assert ($records[2].error -eq 'non-json-content') 'HTML failure'
 Assert ($records[3].status -eq 500) 'HTTP status retained'
 Assert ($records[4].error -eq 'redirect') 'redirect blocked'
 Assert ($records[5].error -eq 'invalid-json') 'malformed JSON'
 Assert ($records[6].error -eq 'credential-in-response') 'reflected key never exported'
 Assert ($records[7].success -eq $true -and $records[7].bytes -gt 4MB) 'large raw stream'
 Assert ($records[8].error -eq 'timeout') 'bounded timeout'
 Assert ($records[9].error -eq 'duplicate-route') 'duplicate explicit failure'
 Assert ($records[10].error -eq 'invalid-layout') 'wrong resolver field/container shapes fail'
 Assert ($records[11].error -eq 'credential-in-response') 'JSON-escaped key never exported'
 $rawFile=Join-Path (Split-Path (Join-Path $testRoot $indexPath)) $records[0].rawFile
 Assert ([IO.File]::ReadAllText($rawFile) -ceq [LayoutTestServer]::Payload) 'raw fidelity including resolver fields and big integer'
 Assert (-not $result.Contains($script:testApiKey.ToString())) 'manifest has no key'
 foreach($file in $manifest.files) {
  Assert (-not [IO.File]::ReadAllText((Join-Path $testRoot $file.path)).Contains($script:testApiKey.ToString())) 'no artifact contains key'
 }
 $requests=$server.Requests.ToArray()
 Assert (@($requests | Where-Object {$_ -like '/sitecore/api/layout/render/jss|/good|source|en|True'}).Count -eq 1) 'correct REST contract, duplicate not fetched'
 Assert (@($requests | Where-Object {$_ -like '/leak*'}).Count -eq 0) 'no redirected credential request'
 foreach($override in @(
  @{ApprovedOrigin='https://elsewhere.invalid'},
  @{Mode='editing'},@{Device='mobile'},@{Version='3'},@{Database='master'},
  @{APIKeyItemPath='/sitecore/content/key'},@{Routes=@(@{item='/';site='source';language='en';device='mobile'})},
  @{TimeoutSeconds=0},@{MaxResponseBytes=0},@{MaxResponseBytes=9007199254740992},
  @{KajooSourceOrigin=$null},@{KajooSourceOrigin='https://other.invalid'}
 )){
  $failed=$false
  try{ $null=Capture @('/good') $override }catch{ $failed=$true;Assert (-not $_.ToString().Contains($script:testApiKey.ToString())) 'validation error redacted' }
  Assert $failed 'unsupported origin/mode/device/version/database/key path fails'
 }
 $limited=Capture @('/chunked') @{MaxResponseBytes=1024} | ConvertFrom-Json
 Assert $limited.summary.partial 'size limit is partial'
 $limitIndex=($limited.files | Where-Object name -eq 'layouts.jsonl').path
 $limitRecord=[IO.File]::ReadAllText((Join-Path $testRoot $limitIndex)) | ConvertFrom-Json
 Assert ($limitRecord.error -eq 'body-limit' -and $null -eq $limitRecord.rawFile) 'stream limit removes incomplete raw file'
 $second=Capture @('/good') | ConvertFrom-Json
 Assert (-not $second.summary.partial) 'complete capture succeeds'
 Assert ($second.files[0].path -ne $manifest.files[0].path) 'unique export directory'
 $higherLimit=Capture @('/good') @{MaxResponseBytes=9007199254740991} | ConvertFrom-Json
 Assert (-not $higherLimit.summary.partial) 'user-selected safe integer limit above former ceiling'
 Write-Output 'PASS layout-capture HTTP contract, raw fidelity, failure matrix, origin/scope safety, secret handling, unique exports'
} finally {
 $server.Dispose()
 Remove-Item -LiteralPath $testRoot -Recurse -Force
}
