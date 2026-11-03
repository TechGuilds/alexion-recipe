FROM mcr.microsoft.com/dotnet/sdk@sha256:d80fdd84f7e18eea12f8e45c52914f1353395009c95c41197178ea19944e6d48 AS build
WORKDIR /build
COPY . .
RUN dotnet restore RoslynAnalyzer.csproj --locked-mode \
    && dotnet publish RoslynAnalyzer.csproj --no-restore -c Release --self-contained false -o /published

FROM mcr.microsoft.com/dotnet/sdk@sha256:d80fdd84f7e18eea12f8e45c52914f1353395009c95c41197178ea19944e6d48
COPY --from=build /published /app
COPY --from=build /build/packages.lock.json /app/packages.lock.json
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1
ENTRYPOINT ["dotnet", "/app/roslyn-analyzer.dll"]
