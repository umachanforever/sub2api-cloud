import {IMAGE_CHAT_FRAME_LIMIT} from './chat_images.ts';
type Item=Record<string,any>;

/** Keep native file cards inline; the client supplies preview, download and clipboard controls. */
export const NATIVE_IMAGE_FILE_GUIDANCE='The gateway delivers generated original PNG/JPEG/WebP files through the client file tool into outputs in the current workspace. Let that download finish: WorkBuddy automatically creates an inline native image card for the saved file. After a successful download, briefly confirm the image is ready. Do not call present_files, show_widget, preview_url, open_result_view or open a browser/side panel automatically. Do not repeat the image as Markdown or print its source URL. The user opens the native preview by clicking the card and can download, save or copy the original there. Never redraw, compress, regenerate or substitute SVG/HTML/canvas for an existing original.';

/** Only choose native file delivery when the caller actually permits a compatible file tool. */
export function nativeImageFileTool(body:Item):string|undefined{
 if(['json_object','json_schema'].includes(body.response_format?.type??body.text?.format?.type))return;
 if(body.tool_choice==='none'||body.tool_choice&&typeof body.tool_choice==='object')return;
 const tools=Array.isArray(body.tools)?body.tools:[];
 if(!tools.some((tool:Item)=>['show_widget','present_files'].includes(tool.name??tool.function?.name)))return;
 const tool=tools.find((tool:Item)=>{
  const spec=tool.function??tool,schema=spec.parameters;
  return tool.type==='function'&&spec.name==='Bash'&&schema?.properties?.command?.type==='string'&&
   (schema.required??[]).every((key:string)=>['command','description','timeout'].includes(key));
 });
 return tool?(tool.function??tool).name:undefined;
}

/** Validate capability sources before embedding them in client commands or image markup. */
export function chatImageSource(value:string):URL{
 const url=new URL(value);
 if(value.length>8192||url.protocol!=='https:'||url.username||url.password||url.hash||
  !/^\/storage\/v1\/object\/sign\/sub2api-artifacts\/images\/imgtask_[a-f0-9]{32}\/image-1\.(png|jpg|webp)$/.test(url.pathname)||
  !url.searchParams.get('token')||[...url.searchParams.keys()].some(key=>key!=='token'))throw new Error('Invalid generated image URL');
 return url;
}

/** Export verified original files into the client's workspace; file watching creates native cards. */
export function nativeImageDownload(sources:string[],name='Bash',parameters?:Item):Item{
 if(!sources.length||sources.length>16)throw new Error('Invalid generated image count');
 const files=[...new Set(sources)].map(source=>{
  const url=chatImageSource(source),extension=url.pathname.split('.').at(-1)!;
  return {url:url.href,name:'sub2api-'+crypto.randomUUID().replaceAll('-','')+'.'+extension};
 });
 // URLs stay inside Python data; shell arguments contain only generated filenames.
 const script=`import json, pathlib, sys, urllib.request
files = json.loads(${JSON.stringify(JSON.stringify(files))})
root = pathlib.Path('outputs')
root.mkdir(exist_ok=True)
images = []
total = 0
for entry, destination in zip(files, sys.argv[1:], strict=True):
    with urllib.request.urlopen(entry['url'], timeout=60) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    total += len(data)
    if not data or len(data) > 20 * 1024 * 1024 or total > 80 * 1024 * 1024:
        raise RuntimeError('Generated image exceeds download limit')
    extension = entry['name'].rsplit('.', 1)[1]
    valid = (extension == 'png' and data.startswith(b'\\x89PNG\\r\\n\\x1a\\n') or
             extension == 'jpg' and data.startswith(b'\\xff\\xd8\\xff') or
             extension == 'webp' and data.startswith(b'RIFF') and data[8:12] == b'WEBP')
    if not valid:
        raise RuntimeError('Invalid original image file')
    path = pathlib.Path(destination)
    if path != root / entry['name']:
        raise RuntimeError('Invalid original image destination')
    if path.exists():
        raise FileExistsError('Original image destination already exists')
    with path.with_suffix('.download').open('xb') as output:
        output.write(data)
    images.append({'localPath': str(path.resolve())})
print(json.dumps({'type': 'image_gen_tool_result', 'status': 'completed', 'images': images}))
`;
 const id='call_imgfile_'+crypto.randomUUID().replaceAll('-','');
 // WorkBuddy's terminal checkpoint tracks ordinary cp destinations, but not
 // arbitrary Python writes or commands following a heredoc. Keep this command
 // on one shell line and publish each verified staging file with an explicit cp.
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
 const paths=files.map(file=>'outputs/'+file.name);
 const copies=paths.map(path=>{
  const staging=path.replace(/\.(png|jpg|webp)$/,'.download');
  return 'cp -n '+quote(staging)+' '+quote(path)+' && rm '+quote(staging);
 });
 const args:Item={command:'python3 -c '+quote('exec('+JSON.stringify(script)+')')+' '+paths.map(quote).join(' ')+' && '+copies.join(' && ')};
 if(!parameters||parameters.properties?.description?.type==='string')args.description='保存生成的原始图片，供聊天卡片预览、复制和下载';
 if(!parameters||['number','integer'].includes(parameters.properties?.timeout?.type))args.timeout=Math.min(120000,parameters?.properties?.timeout?.maximum??120000);
 return {type:'function_call',id,call_id:id,name,arguments:JSON.stringify(args),status:'completed'};
}

export type ImageTextPiece={text:string}|{image:Item};
/** Incrementally isolate provider-generated image markup without buffering ordinary text replies. */
export class ChatImageText{
 private pending='';
 feed(text:string,final=false):ImageTextPiece[]{
  this.pending+=text;
  const result:ImageTextPiece[]=[],prefixes=['![Generated image](','![image]('];
  while(this.pending){
   const starts=prefixes.map(prefix=>({prefix,index:this.pending.indexOf(prefix)})).filter(match=>match.index>=0).sort((a,b)=>a.index-b.index);
   const match=starts[0];
   if(!match){
    let keep=0;
    if(!final)for(const prefix of prefixes)for(let size=1;size<prefix.length;size++)if(this.pending.endsWith(prefix.slice(0,size)))keep=Math.max(keep,size);
    const length=this.pending.length-keep;
    if(length)result.push({text:this.pending.slice(0,length)});
    this.pending=this.pending.slice(length);break;
   }
   if(match.index){result.push({text:this.pending.slice(0,match.index)});this.pending=this.pending.slice(match.index);}
   const end=this.pending.indexOf(')',match.prefix.length);
   if(end<0){
    if(this.pending.length>IMAGE_CHAT_FRAME_LIMIT)throw new Error('Generated image exceeds frame limit');
    if(final){if(this.pending.slice(match.prefix.length).startsWith('data:image/'))throw new Error('Incomplete generated image');result.push({text:this.pending});this.pending='';}
    break;
   }
   const value=this.pending.slice(match.prefix.length,end),data=/^data:image\/(?:png|jpeg|webp|gif);base64,(.*)$/.exec(value);
   if(data)result.push({image:{type:'image_generation_call',status:'completed',result:data[1]}});
   else{
    let source:URL|undefined;try{source=chatImageSource(value);}catch{/* Ordinary links remain text. */}
    result.push(source?{image:{type:'image_generation_call',status:'completed',chat_image_url:source.href}}:{text:this.pending.slice(0,end+1)});
   }
   this.pending=this.pending.slice(end+1);
  }
  return result;
 }
}
