// Same operator endpoint, Origin and action-token boundary as discussion writes.
export function createSessionRoutes({service,actionToken}) {
  return async(request,response,url,{remote,expectedOrigin})=>{
    if(!['/api/assignment-session','/api/assignment-session/end'].includes(url.pathname))return false;
    const send=(status,body)=>{response.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});response.end(JSON.stringify(body));};
    if(remote){send(403,{error:'Session access requires an authorized dashboard endpoint.'});return true;}
    try{
      if(url.pathname==='/api/assignment-session'){
        if(request.method!=='GET'){send(405,{error:'Use GET.'});return true;}
        send(200,await service.describe(url.searchParams.get('assignment_id')));return true;
      }
      if(request.method!=='POST'){send(405,{error:'Use POST.'});return true;}
      if(request.headers.origin?.toLowerCase()!==expectedOrigin.toLowerCase()||request.headers['x-sentinel-token']!==actionToken||request.headers['content-type']!=='application/json'){
        send(403,{error:'Ending a session requires the same-origin dashboard and its action token.'});return true;
      }
      let bytes=0;const chunks=[];
      for await(const chunk of request){bytes+=chunk.length;if(bytes>4096){send(413,{error:'Request is too large.'});return true;}chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{send(400,{error:'Invalid JSON request.'});return true;}
      send(200,await service.end(input));return true;
    }catch(error){send(error.status??(error.code==='ASSIGNMENT_MISSING'?404:409),{error:error.message||'Session action failed. Refresh and retry.'});return true;}
  };
}
