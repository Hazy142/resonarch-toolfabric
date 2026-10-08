using System;
using System.IO;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Host-only copier. Every ancestor remains locked against rename/reparse mutation.
// Final entries are opened without reparse processing; bytes come from that handle.
internal static class WindowsSnapshotHost {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo {
        public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo info);
    private static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=8388608};
    private static readonly List<object> Manifest=new List<object>();
    private static long Total, Maximum; private static int Count;
    private static bool Observe;
    private static string Extended(string path) {return "\\\\?\\"+path;}
    private static SafeFileHandle Pin(string path,out FileInfo info) {
        SafeFileHandle handle=CreateFile(Extended(path),0x80000000,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if(handle.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error(),"CAPSULE_INPUT_OPEN_FAILED");
        try {
            if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());
            if((info.attributes&0x400)!=0)throw new IOException("CAPSULE_SYMLINK_FORBIDDEN");
            if((info.attributes&0x40)!=0)throw new IOException("CAPSULE_SPECIAL_FILE_FORBIDDEN");
            return handle;
        } catch {handle.Dispose();throw;}
    }
    private static void Event(string path,string kind) {
        if(!Observe)return;
        Console.WriteLine(Json.Serialize(new {type="entry",path=path,kind=kind}));Console.Out.Flush();
        if(Console.ReadLine()!="continue")throw new IOException("CAPSULE_SNAPSHOT_ABORTED");
    }
    private static string Hex(byte[] bytes) {return "sha256:"+BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();}
    private static void Walk(string input,string output,string relative) {
        Directory.CreateDirectory(output);
        string[] entries=Directory.GetFileSystemEntries(input);Array.Sort(entries,StringComparer.Ordinal);
        foreach(string raw in entries) {
            if(++Count>20000)throw new IOException("CAPSULE_INPUT_LIMIT");
            string name=Path.GetFileName(raw),from=Path.Combine(input,name),to=Path.Combine(output,name);
            string path=relative.Length==0?name:relative+"/"+name;FileInfo info;
            using(SafeFileHandle handle=Pin(from,out info)) {
                bool directory=(info.attributes&0x10)!=0;
                Event(path,directory?"directory":"file");
                if(directory) {
                    Manifest.Add(new {path=path,kind="directory",sha256=Hex(SHA256.Create().ComputeHash(System.Text.Encoding.UTF8.GetBytes("directory"))),mode=365});
                    Walk(from,to,path);
                } else {
                    long expected=((long)info.sizeHigh<<32)|info.sizeLow;
                    if(expected>Maximum-Total)throw new IOException("CAPSULE_INPUT_LIMIT");
                    using(FileStream source=new FileStream(handle,FileAccess.Read))
                    using(FileStream destination=new FileStream(to,FileMode.CreateNew,FileAccess.Write,FileShare.None))
                    using(SHA256 hash=SHA256.Create()) {
                        byte[] buffer=new byte[65536];int amount;
                        while((amount=source.Read(buffer,0,buffer.Length))>0) {
                            Total+=amount;if(Total>Maximum)throw new IOException("CAPSULE_INPUT_LIMIT");
                            destination.Write(buffer,0,amount);hash.TransformBlock(buffer,0,amount,buffer,0);
                        }
                        hash.TransformFinalBlock(new byte[0],0,0);
                        Manifest.Add(new {path=path,kind="file",sha256=Hex(hash.Hash),mode=292});
                    }
                }
            }
        }
    }
    public static int Main(string[] args) {
        var ancestors=new List<SafeFileHandle>();
        try {
            if(args.Length!=4)throw new IOException("INVALID_SNAPSHOT_ARGUMENTS");
            string source=Path.GetFullPath(args[0]),destination=Path.GetFullPath(args[1]);Observe=args[2]=="observe";
            Maximum=long.Parse(args[3]);if(Maximum<1||Maximum>536870912)throw new IOException("CAPSULE_INPUT_LIMIT");
            // UNC/device paths and ancestor reparse points are outside this local profile.
            if(source.Length<3||source[1]!=':'||source[2]!='\\')throw new IOException("CAPSULE_SOURCE_UNSUPPORTED");
            string probe=Path.GetPathRoot(source);FileInfo info;
            ancestors.Add(Pin(probe,out info));
            foreach(string component in source.Substring(probe.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)) {
                probe=Path.Combine(probe,component);var handle=Pin(probe,out info);ancestors.Add(handle);
                if((info.attributes&0x10)==0)throw new IOException("CAPSULE_SOURCE_NOT_DIRECTORY");
            }
            Walk(source,destination,"");
            Console.WriteLine(Json.Serialize(new {type="done",manifest=Manifest}));return 0;
        } catch(Exception error) {Console.Error.WriteLine(error.Message);return 1;}
        finally {for(int index=ancestors.Count-1;index>=0;index--)ancestors[index].Dispose();}
    }
}
